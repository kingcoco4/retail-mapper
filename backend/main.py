"""
FastAPI Backend for Texas Business Mapper
Separate scrape/geocode caching + Census batch geocoding + live updates
"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import sqlite3
from typing import List, Optional
from pydantic import BaseModel
import requests
from bs4 import BeautifulSoup
import time
from pathlib import Path
import logging
import asyncio
import json
from io import StringIO
import csv
from datetime import datetime

# Configure logging (no emojis)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Texas Business Mapper API")
app.add_middleware(CORSMiddleware, allow_origins=["*"])

# Cache directories
SCRAPE_CACHE_DIR = Path("cache/scraped")
GEOCODE_CACHE_DIR = Path("cache/geocoded")
SCRAPE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
GEOCODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Database
DB_PATH = Path("businesses.db")

# WebSocket connections for live updates
active_connections: List[WebSocket] = []

# Pydantic models
class Business(BaseModel):
    name: str
    address: str
    status: str
    permit_begin: Optional[str] = None
    permit_end: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None

class ZipCodeInfo(BaseModel):
    zipcode: str
    business_count: int
    scrape_cached: bool
    geocode_cached: bool

class GeocodeProgress(BaseModel):
    zipcode: str
    total: int
    completed: int
    success: int
    failed: int
    current_address: Optional[str] = None

# Database initialization
def init_db():
    """Initialize SQLite database"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS businesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            zipcode TEXT NOT NULL,
            name TEXT NOT NULL,
            address TEXT,
            status TEXT,
            permit_begin TEXT,
            permit_end TEXT,
            lat REAL,
            lon REAL,
            cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            geocoded_at DATETIME,
            geocode_source TEXT,
            UNIQUE(zipcode, name, address)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_zipcode ON businesses(zipcode)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_geocoded ON businesses(lat, lon) WHERE lat IS NOT NULL')
    conn.commit()
    conn.close()
    logger.info("Database initialized")

init_db()

# WebSocket manager
async def broadcast_progress(data: dict):
    """Broadcast geocoding progress to all connected clients"""
    disconnected = []
    for connection in active_connections:
        try:
            await connection.send_json(data)
        except:
            disconnected.append(connection)
    
    for conn in disconnected:
        active_connections.remove(conn)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for live updates"""
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"WebSocket connected. Total connections: {len(active_connections)}")
    
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)
        logger.info(f"WebSocket disconnected. Total connections: {len(active_connections)}")

# API Endpoints

@app.get("/")
def root():
    return {
        "message": "Texas Business Mapper API",
        "version": "2.0",
        "endpoints": {
            "zipcodes": "/api/zipcodes",
            "businesses": "/api/businesses/{zipcode}",
            "timeline": "/api/businesses/{zipcode}/timeline",
            "geocode": "/api/geocode/{zipcode}",
            "stats": "/api/stats",
            "docs": "/docs"
        }
    }

@app.get("/api/zipcodes", response_model=List[ZipCodeInfo])
def get_cached_zipcodes():
    """Return list of cached ZIP codes with cache status"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.execute("""
        SELECT 
            zipcode, 
            COUNT(*) as count,
            COUNT(CASE WHEN lat IS NOT NULL THEN 1 END) as geocoded_count
        FROM businesses 
        GROUP BY zipcode 
        ORDER BY zipcode
    """)
    
    results = []
    for row in cursor.fetchall():
        zipcode = row[0]
        total_count = row[1]
        geocoded_count = row[2]
        
        scrape_cached = (SCRAPE_CACHE_DIR / f"{zipcode}.json").exists()
        geocode_cached = geocoded_count == total_count
        
        results.append(ZipCodeInfo(
            zipcode=zipcode,
            business_count=total_count,
            scrape_cached=scrape_cached,
            geocode_cached=geocode_cached
        ))
    
    conn.close()
    logger.info(f"Retrieved {len(results)} cached ZIP codes")
    return results

@app.get("/api/businesses/{zipcode}", response_model=List[Business])
def get_businesses(zipcode: str, active_only: bool = False):
    """Get businesses for ZIP code"""
    if len(zipcode) != 5 or not zipcode.isdigit():
        raise HTTPException(status_code=400, detail="Invalid ZIP code format")
    
    logger.info(f"Request for ZIP code: {zipcode}, active_only={active_only}")
    
    conn = sqlite3.connect(DB_PATH)
    
    cursor = conn.execute(
        "SELECT name, address, status, permit_begin, permit_end, lat, lon FROM businesses WHERE zipcode = ?",
        (zipcode,)
    )
    cached = cursor.fetchall()
    
    if cached:
        logger.info(f"Found {len(cached)} cached businesses for ZIP {zipcode}")
        businesses = [
            Business(
                name=row[0], 
                address=row[1], 
                status=row[2],
                permit_begin=row[3],
                permit_end=row[4],
                lat=row[5], 
                lon=row[6]
            )
            for row in cached
        ]
        conn.close()
        
        if active_only:
            businesses = [b for b in businesses if b.status == 'ACTIVE']
        
        return businesses
    
    logger.info(f"No cache found for ZIP {zipcode}, initiating scrape")
    
    scrape_cache_file = SCRAPE_CACHE_DIR / f"{zipcode}.json"
    
    if scrape_cache_file.exists():
        logger.info(f"Loading from scrape cache file: {scrape_cache_file}")
        with open(scrape_cache_file, 'r') as f:
            raw_businesses = json.load(f)
    else:
        logger.info(f"No scrape cache file found, scraping from source")
        raw_businesses = scrape_zipcode(zipcode)
        
        with open(scrape_cache_file, 'w') as f:
            json.dump(raw_businesses, f, indent=2)
        logger.info(f"Saved {len(raw_businesses)} businesses to scrape cache")
    
    businesses = []
    for biz in raw_businesses:
        cursor = conn.execute("""
            INSERT OR IGNORE INTO businesses 
            (zipcode, name, address, status, permit_begin, permit_end, lat, lon)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
        """, (
            zipcode,
            biz.get('name', 'Unknown'),
            biz.get('address', ''),
            biz.get('status', 'UNKNOWN'),
            biz.get('permit_begin'),
            biz.get('permit_end')
        ))
        
        businesses.append(Business(
            name=biz.get('name', 'Unknown'),
            address=biz.get('address', ''),
            status=biz.get('status', 'UNKNOWN'),
            permit_begin=biz.get('permit_begin'),
            permit_end=biz.get('permit_end'),
            lat=None,
            lon=None
        ))
    
    conn.commit()
    conn.close()
    
    logger.info(f"Stored {len(businesses)} businesses in database (not geocoded)")
    
    return businesses

@app.get("/api/businesses/{zipcode}/timeline")
def get_businesses_timeline(zipcode: str):
    """Get businesses with timeline data"""
    if len(zipcode) != 5 or not zipcode.isdigit():
        raise HTTPException(status_code=400, detail="Invalid ZIP code format")
    
    conn = sqlite3.connect(DB_PATH)
    
    cursor = conn.execute(
        "SELECT COUNT(*) FROM businesses WHERE zipcode = ?",
        (zipcode,)
    )
    count = cursor.fetchone()[0]
    
    if count == 0:
        logger.info(f"No data found for ZIP {zipcode}, scraping now...")
        raw_businesses = scrape_zipcode(zipcode)
        
        if not raw_businesses:
            conn.close()
            return {'businesses': [], 'min_date': None, 'max_date': None}
        
        for biz in raw_businesses:
            conn.execute("""
                INSERT OR IGNORE INTO businesses 
                (zipcode, name, address, status, permit_begin, permit_end, lat, lon)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
            """, (
                zipcode,
                biz.get('name', 'Unknown'),
                biz.get('address', ''),
                biz.get('status', 'UNKNOWN'),
                biz.get('permit_begin'),
                biz.get('permit_end')
            ))
        
        conn.commit()
        logger.info(f"Stored {len(raw_businesses)} businesses for ZIP {zipcode}")
    
    cursor = conn.execute("""
        SELECT 
            name,
            address,
            status,
            lat,
            lon,
            permit_begin,
            permit_end
        FROM businesses
        WHERE zipcode = ?
        AND lat IS NOT NULL
        ORDER BY permit_begin
    """, (zipcode,))
    
    results = []
    for row in cursor.fetchall():
        permit_begin = row[5]
        permit_end = row[6]
        
        # Parse dates - handle MM/DD/YYYY format from Texas Comptroller
        begin_date = None
        end_date = None
        
        if permit_begin:
            try:
                # Try MM/DD/YYYY format first (Texas Comptroller format)
                begin_date = datetime.strptime(permit_begin, '%m/%d/%Y')
            except ValueError:
                try:
                    # Fallback to YYYY-MM-DD format
                    begin_date = datetime.strptime(permit_begin, '%Y-%m-%d')
                except ValueError:
                    logger.warning(f"Could not parse begin date: {permit_begin}")
        
        if permit_end:
            try:
                # Try MM/DD/YYYY format first
                end_date = datetime.strptime(permit_end, '%m/%d/%Y')
            except ValueError:
                try:
                    # Fallback to YYYY-MM-DD format
                    end_date = datetime.strptime(permit_end, '%Y-%m-%d')
                except ValueError:
                    logger.warning(f"Could not parse end date: {permit_end}")
        
        # Use current date if no end date
        if not end_date:
            end_date = datetime.now()
        
        results.append({
            'name': row[0],
            'address': row[1],
            'status': row[2],
            'lat': row[3],
            'lon': row[4],
            'permit_begin': permit_begin,
            'permit_end': permit_end,
            'begin_timestamp': begin_date.timestamp() if begin_date else None,
            'end_timestamp': end_date.timestamp() if end_date else datetime.now().timestamp()
        })
    
    conn.close()
    
    if not results:
        return {
            'businesses': [],
            'min_date': None,
            'max_date': None
        }
    
    all_dates = [r['begin_timestamp'] for r in results if r['begin_timestamp']]
    
    return {
        'businesses': results,
        'min_date': min(all_dates) if all_dates else None,
        'max_date': max([r['end_timestamp'] for r in results]) if results else None
    }

@app.post("/api/geocode/{zipcode}")
async def geocode_zipcode_endpoint(zipcode: str):
    """Trigger geocoding for a ZIP code"""
    if len(zipcode) != 5 or not zipcode.isdigit():
        raise HTTPException(status_code=400, detail="Invalid ZIP code format")
    
    logger.info(f"Geocoding request received for ZIP {zipcode}")
    
    geocode_cache_file = GEOCODE_CACHE_DIR / f"{zipcode}.json"
    
    if geocode_cache_file.exists():
        logger.info(f"ZIP {zipcode} already geocoded (cache file exists)")
        return {"status": "already_geocoded", "zipcode": zipcode}
    
    asyncio.create_task(geocode_zipcode_background(zipcode))
    
    return {"status": "geocoding_started", "zipcode": zipcode}

async def geocode_zipcode_background(zipcode: str):
    """Background task to geocode addresses with live updates"""
    logger.info(f"Starting background geocoding for ZIP {zipcode}")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.execute(
        "SELECT id, address FROM businesses WHERE zipcode = ? AND lat IS NULL",
        (zipcode,)
    )
    ungeocoded = cursor.fetchall()
    
    total = len(ungeocoded)
    logger.info(f"Found {total} addresses to geocode")
    
    if total == 0:
        conn.close()
        logger.info(f"No addresses to geocode for ZIP {zipcode}")
        return
    
    await broadcast_progress({
        "type": "geocode_start",
        "zipcode": zipcode,
        "total": total
    })
    
    batch_size = 500
    completed = 0
    success_count = 0
    failed_count = 0
    
    for batch_start in range(0, total, batch_size):
        batch_end = min(batch_start + batch_size, total)
        batch = ungeocoded[batch_start:batch_end]
        
        logger.info(f"Processing batch {batch_start//batch_size + 1}: addresses {batch_start+1}-{batch_end} of {total}")
        
        batch_data = [{"id": row[0], "address": row[1]} for row in batch]
        results = geocode_batch_census(batch_data, zipcode)
        
        for result in results:
            biz_id = result['id']
            lat = result.get('lat')
            lon = result.get('lon')
            
            if lat and lon:
                conn.execute("""
                    UPDATE businesses 
                    SET lat = ?, lon = ?, geocoded_at = CURRENT_TIMESTAMP, geocode_source = 'census'
                    WHERE id = ?
                """, (lat, lon, biz_id))
                success_count += 1
                logger.debug(f"Successfully geocoded business ID {biz_id}")
            else:
                failed_count += 1
                logger.debug(f"Failed to geocode business ID {biz_id}")
            
            completed += 1
            
            if completed % 10 == 0:
                await broadcast_progress({
                    "type": "geocode_progress",
                    "zipcode": zipcode,
                    "total": total,
                    "completed": completed,
                    "success": success_count,
                    "failed": failed_count,
                    "percent": round(completed / total * 100, 1)
                })
        
        conn.commit()
        logger.info(f"Batch complete: {success_count} success, {failed_count} failed")
        
        await asyncio.sleep(0.5)
    
    conn.close()
    
    geocode_cache_file = GEOCODE_CACHE_DIR / f"{zipcode}.json"
    with open(geocode_cache_file, 'w') as f:
        json.dump({
            "zipcode": zipcode,
            "total": total,
            "success": success_count,
            "failed": failed_count,
            "completed_at": time.strftime("%Y-%m-%d %H:%M:%S")
        }, f, indent=2)
    
    logger.info(f"Geocoding complete for ZIP {zipcode}: {success_count}/{total} success")
    
    await broadcast_progress({
        "type": "geocode_complete",
        "zipcode": zipcode,
        "total": total,
        "success": success_count,
        "failed": failed_count
    })

def geocode_batch_census(addresses: List[dict], zipcode: str) -> List[dict]:
    """Geocode batch using US Census Geocoder"""
    logger.info(f"Sending batch of {len(addresses)} addresses to Census API")
    
    csv_lines = [f"{addr['id']},{addr['address']},,,{zipcode}" for addr in addresses]
    csv_content = '\n'.join(csv_lines)
    
    url = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
    files = {'addressFile': ('batch.csv', csv_content, 'text/csv')}
    data = {
        'benchmark': 'Public_AR_Current',
        'vintage': 'Current_Current'
    }
    
    try:
        logger.debug(f"Posting to Census API: {url}")
        response = requests.post(url, files=files, data=data, timeout=120)
        response.raise_for_status()
        
        logger.info(f"Census API response received, parsing results")
        
        results = []
        csv_reader = csv.reader(StringIO(response.text))
        
        for line_num, row in enumerate(csv_reader):
            if not row:
                continue
            
            if line_num < 3:
                logger.debug(f"Parsing line {line_num}: {len(row)} columns")
                logger.debug(f"  Row: {row[:8]}")
            
            if len(row) >= 6:
                biz_id = int(row[0])
                match_status = row[2]
                coords_str = row[5] if len(row) > 5 else ''
                
                result = {'id': biz_id, 'lat': None, 'lon': None}
                
                if match_status == 'Match' and coords_str:
                    try:
                        lon, lat = coords_str.split(',')
                        result['lat'] = float(lat.strip())
                        result['lon'] = float(lon.strip())
                        
                        if line_num < 3:
                            logger.debug(f"  SUCCESS: Extracted coords: ({result['lat']}, {result['lon']})")
                    except Exception as e:
                        if line_num < 3:
                            logger.warning(f"  Failed to parse coords from '{coords_str}': {e}")
                
                if line_num < 3 and result['lat'] is None:
                    logger.warning(f"  FAILED: No coordinates extracted")
                    logger.warning(f"    Match status: '{match_status}'")
                    logger.warning(f"    Coords string: '{coords_str}'")
                
                results.append(result)
        
        successful = sum(1 for r in results if r['lat'] is not None)
        logger.info(f"Parsed {len(results)} results from Census API ({successful} with coordinates)")
        return results
        
    except Exception as e:
        logger.error(f"Census batch geocoding failed: {e}")
        return [{'id': addr['id'], 'lat': None, 'lon': None} for addr in addresses]

def scrape_zipcode(zipcode: str) -> list:
    """Scrape businesses from Texas Comptroller website"""
    logger.info(f"Starting scrape for ZIP code {zipcode}")
    
    url = "https://mycpa.cpa.state.tx.us/staxpayersearch/locationSearch.do"
    
    payload = {
        "zipCode": zipcode,
        "city": "",
        "taxpayerName": "",
        "permitNumber": "",
        "searchType": "location",
    }
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    
    try:
        logger.debug(f"Posting to: {url}")
        response = requests.post(url, data=payload, headers=headers, timeout=30)
        response.raise_for_status()
        
        logger.debug("Parsing HTML response")
        soup = BeautifulSoup(response.text, "html.parser")
        table = soup.find("table", {"class": "table-bordered"})
        
        if not table:
            logger.warning(f"No results table found for ZIP {zipcode}")
            return []
        
        businesses = []
        
        for tr in table.find_all("tr")[1:]:
            for a in tr.find_all("a"):
                a.decompose()
            
            tds = [td.get_text(strip=True) for td in tr.find_all("td")]
            
            if len(tds) >= 4:
                businesses.append({
                    'name': tds[0] if len(tds) > 0 else 'Unknown',
                    'status': tds[1] if len(tds) > 1 else 'UNKNOWN',
                    'address': tds[2] if len(tds) > 2 else '',
                    'city_state_zip': tds[3] if len(tds) > 3 else '',
                    'permit_begin': tds[6] if len(tds) > 6 else None,
                    'permit_end': tds[7] if len(tds) > 7 else None,
                })
        
        logger.info(f"Successfully scraped {len(businesses)} businesses from ZIP {zipcode}")
        return businesses
        
    except requests.exceptions.Timeout:
        logger.error(f"Timeout while scraping ZIP {zipcode}")
        return []
    except requests.exceptions.RequestException as e:
        logger.error(f"Request error scraping ZIP {zipcode}: {e}")
        return []
    except Exception as e:
        logger.error(f"Unexpected error scraping ZIP {zipcode}: {e}")
        return []

@app.get("/api/stats")
def get_stats():
    """Get overall statistics"""
    conn = sqlite3.connect(DB_PATH)
    
    stats = {}
    cursor = conn.execute("SELECT COUNT(*) FROM businesses")
    stats['total_businesses'] = cursor.fetchone()[0]
    
    cursor = conn.execute("SELECT COUNT(*) FROM businesses WHERE lat IS NOT NULL")
    stats['geocoded'] = cursor.fetchone()[0]
    
    cursor = conn.execute("SELECT COUNT(DISTINCT zipcode) FROM businesses")
    stats['zipcodes_cached'] = cursor.fetchone()[0]
    
    stats['scrape_cache_files'] = len(list(SCRAPE_CACHE_DIR.glob("*.json")))
    stats['geocode_cache_files'] = len(list(GEOCODE_CACHE_DIR.glob("*.json")))
    
    conn.close()
    
    logger.info(f"Stats request: {stats}")
    return stats

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Texas Business Mapper API")
    logger.info(f"API: http://localhost:8000")
    logger.info(f"Docs: http://localhost:8000/docs")
    logger.info(f"Scrape cache: {SCRAPE_CACHE_DIR.absolute()}")
    logger.info(f"Geocode cache: {GEOCODE_CACHE_DIR.absolute()}")
    uvicorn.run(app, host="0.0.0.0", port=8000)