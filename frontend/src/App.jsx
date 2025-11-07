import { useState, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import axios from 'axios'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'

// Fix Leaflet icons
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

const API_URL = 'http://localhost:8000/api'
const WS_URL = 'ws://localhost:8000/ws'

function MapUpdater({ center, zoom }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, zoom)
  }, [center, zoom, map])
  return null
}

function App() {
  const [zipcode, setZipcode] = useState('')
  const [cachedZips, setCachedZips] = useState([])
  const [businesses, setBusinesses] = useState([])
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [geocodeProgress, setGeocodeProgress] = useState(null)
  const [activeOnly, setActiveOnly] = useState(true)
  const [mapCenter, setMapCenter] = useState([31.5, -99.5])
  const [mapZoom, setMapZoom] = useState(6)
  const [error, setError] = useState(null)
  const [ws, setWs] = useState(null)

  // WebSocket connection
  useEffect(() => {
    const websocket = new WebSocket(WS_URL)
    
    websocket.onopen = () => {
      console.log('WebSocket connected')
    }
    
    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      console.log('WebSocket message:', data)
      
      if (data.type === 'geocode_start') {
        setGeocoding(true)
        setGeocodeProgress({
          zipcode: data.zipcode,
          total: data.total,
          completed: 0,
          success: 0,
          failed: 0
        })
      } else if (data.type === 'geocode_progress') {
        setGeocodeProgress({
          zipcode: data.zipcode,
          total: data.total,
          completed: data.completed,
          success: data.success,
          failed: data.failed,
          percent: data.percent
        })
        
        // Refresh map data
        if (data.zipcode === zipcode) {
          loadBusinesses(data.zipcode)
        }
      } else if (data.type === 'geocode_complete') {
        setGeocoding(false)
        setGeocodeProgress(null)
        
        // Final refresh
        if (data.zipcode === zipcode) {
          loadBusinesses(data.zipcode)
        }
        
        loadCachedZips()
        loadStats()
      }
    }
    
    websocket.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
    
    websocket.onclose = () => {
      console.log('WebSocket disconnected')
    }
    
    setWs(websocket)
    
    return () => {
      websocket.close()
    }
  }, [zipcode])

  useEffect(() => {
    loadCachedZips()
    loadStats()
  }, [])

  const loadCachedZips = async () => {
    try {
      const res = await axios.get(`${API_URL}/zipcodes`)
      setCachedZips(res.data)
    } catch (error) {
      console.error('Error loading zips:', error)
    }
  }

  const loadStats = async () => {
    try {
      const res = await axios.get(`${API_URL}/stats`)
      setStats(res.data)
    } catch (error) {
      console.error('Error loading stats:', error)
    }
  }

  const loadBusinesses = async (zip) => {
    try {
      const res = await axios.get(`${API_URL}/businesses/${zip}?active_only=${activeOnly}`)
      setBusinesses(res.data)
      
      const firstGeocoded = res.data.find(b => b.lat && b.lon)
      if (firstGeocoded) {
        setMapCenter([firstGeocoded.lat, firstGeocoded.lon])
        setMapZoom(13)
      }
    } catch (error) {
      console.error('Error loading businesses:', error)
    }
  }

  const handleSearch = async () => {
    if (!zipcode.trim() || zipcode.length !== 5) {
      setError('Please enter a valid 5-digit ZIP code')
      return
    }

    setLoading(true)
    setError(null)
    
    try {
      await loadBusinesses(zipcode)
      loadCachedZips()
      loadStats()
    } catch (error) {
      setError(`Error loading businesses for ZIP ${zipcode}`)
    } finally {
      setLoading(false)
    }
  }

  const handleGeocode = async () => {
    if (!zipcode.trim() || zipcode.length !== 5) {
      setError('Please enter a valid ZIP code to geocode')
      return
    }
    
    try {
      await axios.post(`${API_URL}/geocode/${zipcode}`)
      setGeocoding(true)
    } catch (error) {
      setError('Error starting geocoding')
    }
  }

  const handleZipClick = async (zip) => {
    setZipcode(zip)
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <div style={{
        width: '350px',
        padding: '20px',
        overflowY: 'auto',
        borderRight: '1px solid #ddd',
        backgroundColor: '#f8f9fa'
      }}>
        <h1 style={{ fontSize: '24px', marginBottom: '20px' }}>
          Texas Business Mapper
        </h1>

        {/* Search */}
        <div style={{ marginBottom: '20px' }}>
          <input
            type="text"
            placeholder="Enter ZIP code (e.g., 75231)"
            value={zipcode}
            onChange={(e) => setZipcode(e.target.value)}
            onKeyPress={handleKeyPress}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid #ddd',
              marginBottom: '10px',
              fontSize: '14px'
            }}
          />
          
          <label style={{ 
            display: 'flex', 
            alignItems: 'center', 
            marginBottom: '10px',
            cursor: 'pointer'
          }}>
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            <span style={{ fontSize: '14px' }}>Active businesses only</span>
          </label>

          <button
            onClick={handleSearch}
            disabled={loading}
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: loading ? '#ccc' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              fontSize: '14px',
              marginBottom: '5px'
            }}
          >
            {loading ? 'Loading...' : 'Search'}
          </button>

          <button
            onClick={handleGeocode}
            disabled={geocoding || !zipcode}
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: geocoding ? '#ccc' : '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: geocoding ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              fontSize: '14px'
            }}
          >
            {geocoding ? 'Geocoding...' : 'Geocode ZIP'}
          </button>

          {error && (
            <div style={{
              marginTop: '10px',
              padding: '10px',
              backgroundColor: '#fff3cd',
              border: '1px solid #ffc107',
              borderRadius: '4px',
              fontSize: '12px',
              color: '#856404'
            }}>
              {error}
            </div>
          )}

          {geocodeProgress && (
            <div style={{
              marginTop: '10px',
              padding: '10px',
              backgroundColor: '#d1ecf1',
              border: '1px solid #bee5eb',
              borderRadius: '4px',
              fontSize: '12px'
            }}>
              <div><strong>Geocoding Progress</strong></div>
              <div>ZIP: {geocodeProgress.zipcode}</div>
              <div>
                {geocodeProgress.completed} / {geocodeProgress.total} 
                ({geocodeProgress.percent}%)
              </div>
              <div>Success: {geocodeProgress.success}</div>
              <div>Failed: {geocodeProgress.failed}</div>
              <div style={{
                marginTop: '5px',
                height: '10px',
                backgroundColor: '#e9ecef',
                borderRadius: '5px',
                overflow: 'hidden'
              }}>
                <div style={{
                  height: '100%',
                  width: `${geocodeProgress.percent || 0}%`,
                  backgroundColor: '#007bff',
                  transition: 'width 0.3s'
                }}></div>
              </div>
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{
          padding: '15px',
          backgroundColor: 'white',
          borderRadius: '4px',
          marginBottom: '20px',
          border: '1px solid #ddd'
        }}>
          <h3 style={{ marginBottom: '10px', fontSize: '16px' }}>Statistics</h3>
          <div style={{ fontSize: '14px', lineHeight: '1.8' }}>
            <div>Total Businesses: {stats.total_businesses?.toLocaleString() || 0}</div>
            <div>Geocoded: {stats.geocoded?.toLocaleString() || 0}</div>
            <div>ZIP Codes: {stats.zipcodes_cached || 0}</div>
            <div>Scrape Cache: {stats.scrape_cache_files || 0} files</div>
            <div>Geocode Cache: {stats.geocode_cache_files || 0} files</div>
            <div>Showing: {businesses.length} businesses</div>
          </div>
        </div>

        {/* Cached ZIPs */}
        <div>
          <h3 style={{ marginBottom: '10px', fontSize: '16px' }}>
            Cached ZIP Codes ({cachedZips.length})
          </h3>
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            {cachedZips.length === 0 ? (
              <div style={{
                padding: '20px',
                textAlign: 'center',
                color: '#666',
                fontSize: '14px'
              }}>
                No ZIP codes cached yet. Search for a ZIP code to get started.
              </div>
            ) : (
              cachedZips.map((zip) => (
                <div
                  key={zip.zipcode}
                  onClick={() => handleZipClick(zip.zipcode)}
                  style={{
                    padding: '10px',
                    marginBottom: '5px',
                    backgroundColor: zipcode === zip.zipcode ? '#007bff' : 'white',
                    color: zipcode === zip.zipcode ? 'white' : 'black',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    border: '1px solid #ddd',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (zipcode !== zip.zipcode) {
                      e.currentTarget.style.backgroundColor = '#e9ecef'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (zipcode !== zip.zipcode) {
                      e.currentTarget.style.backgroundColor = 'white'
                    }
                  }}
                >
                  <strong style={{ fontSize: '14px' }}>{zip.zipcode}</strong>
                  <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '2px' }}>
                    {zip.business_count} businesses
                    {zip.geocode_cached && <span> (geocoded)</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative' }}>
        {(loading || geocoding) && (
          <div style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'white',
            padding: '10px 20px',
            borderRadius: '4px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            zIndex: 1000,
            fontSize: '14px'
          }}>
            {loading ? 'Loading businesses...' : 'Geocoding in progress...'}
          </div>
        )}

        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{ width: '100%', height: '100%' }}
        >
          <MapUpdater center={mapCenter} zoom={mapZoom} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {businesses
            .filter(b => b.lat && b.lon)
            .map((business, idx) => (
              <Marker
                key={`${business.name}-${idx}`}
                position={[business.lat, business.lon]}
              >
                <Popup maxWidth={300}>
                  <div style={{ minWidth: '200px' }}>
                    <h4 style={{ marginBottom: '8px', fontSize: '14px' }}>
                      {business.name}
                    </h4>
                    <div style={{ fontSize: '12px', lineHeight: '1.6' }}>
                      <div><strong>Address:</strong> {business.address}</div>
                      <div>
                        <strong>Status:</strong>{' '}
                        <span style={{
                          color: business.status === 'ACTIVE' ? 'green' : 'red',
                          fontWeight: 'bold'
                        }}>
                          {business.status}
                        </span>
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>
    </div>
  )
}

export default App
