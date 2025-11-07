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

// Helper functions
function formatDate(dateString) {
  if (!dateString) return 'N/A'
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  })
}

function formatDateShort(dateString) {
  if (!dateString) return 'Present'
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short'
  })
}

function calculateDuration(startDate, endDate) {
  if (!startDate) return 'Unknown'
  
  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : new Date()
  
  const years = end.getFullYear() - start.getFullYear()
  const months = end.getMonth() - start.getMonth()
  
  const totalMonths = years * 12 + months
  const displayYears = Math.floor(totalMonths / 12)
  const displayMonths = totalMonths % 12
  
  if (displayYears > 0 && displayMonths > 0) {
    return `${displayYears}y ${displayMonths}m`
  } else if (displayYears > 0) {
    return `${displayYears} year${displayYears > 1 ? 's' : ''}`
  } else {
    return `${displayMonths} month${displayMonths > 1 ? 's' : ''}`
  }
}

function MapUpdater({ center, zoom }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, zoom)
  }, [center, zoom, map])
  return null
}

// Timeline Slider Component
function TimelineSlider({ minDate, maxDate, currentDate, onDateChange, businesses }) {
  const [isDragging, setIsDragging] = useState(false)
  
  const handleSliderChange = (e) => {
    const timestamp = parseFloat(e.target.value)
    onDateChange(timestamp)
  }
  
  const formatSliderDate = (timestamp) => {
    if (!timestamp) return ''
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
  }
  
  // Count businesses active at current date
  const activeCount = businesses.filter(b => {
    const begin = b.begin_timestamp
    const end = b.end_timestamp
    return begin && begin <= currentDate && currentDate <= end
  }).length
  
  return (
    <div style={{
      position: 'absolute',
      bottom: '30px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: 'white',
      padding: '15px 20px',
      borderRadius: '8px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      zIndex: 1000,
      minWidth: '400px',
      maxWidth: '600px'
    }}>
      <div style={{ 
        marginBottom: '10px', 
        display: 'flex', 
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <strong style={{ fontSize: '14px' }}>Timeline Filter</strong>
        <span style={{ 
          fontSize: '12px', 
          color: '#666',
          backgroundColor: '#e3f2fd',
          padding: '3px 8px',
          borderRadius: '4px'
        }}>
          {activeCount} active business{activeCount !== 1 ? 'es' : ''}
        </span>
      </div>
      
      <div style={{ marginBottom: '8px' }}>
        <input
          type="range"
          min={minDate}
          max={maxDate}
          value={currentDate}
          onChange={handleSliderChange}
          onMouseDown={() => setIsDragging(true)}
          onMouseUp={() => setIsDragging(false)}
          onTouchStart={() => setIsDragging(true)}
          onTouchEnd={() => setIsDragging(false)}
          style={{
            width: '100%',
            height: '6px',
            borderRadius: '3px',
            outline: 'none',
            cursor: 'pointer'
          }}
        />
      </div>
      
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between',
        fontSize: '11px',
        color: '#666'
      }}>
        <span>{formatSliderDate(minDate)}</span>
        <span style={{ fontWeight: 'bold', color: '#007bff' }}>
          {formatSliderDate(currentDate)}
        </span>
        <span>{formatSliderDate(maxDate)}</span>
      </div>
    </div>
  )
}

// Timeline component for popup
function BusinessTimeline({ business }) {
  const isActive = business.status === 'ACTIVE' || !business.permit_end
  
  return (
    <div style={{
      position: 'relative',
      padding: '10px 0',
      borderLeft: '3px solid #007bff',
      marginBottom: '10px'
    }}>
      <div style={{ paddingLeft: '15px', marginBottom: '5px' }}>
        <div style={{ fontSize: '10px', color: '#999', fontWeight: 'bold' }}>
          OPENED
        </div>
        <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
          {formatDate(business.permit_begin)}
        </div>
      </div>
      
      <div style={{
        paddingLeft: '15px',
        margin: '10px 0',
        fontStyle: 'italic',
        color: '#666',
        fontSize: '11px'
      }}>
        {calculateDuration(business.permit_begin, business.permit_end)}
      </div>
      
      {business.permit_end ? (
        <div style={{ paddingLeft: '15px' }}>
          <div style={{ fontSize: '10px', color: '#999', fontWeight: 'bold' }}>
            CLOSED
          </div>
          <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
            {formatDate(business.permit_end)}
          </div>
        </div>
      ) : (
        <div style={{
          paddingLeft: '15px',
          color: 'green',
          fontWeight: 'bold',
          fontSize: '12px'
        }}>
          Still Operating
        </div>
      )}
    </div>
  )
}

// Multi-business popup component
function MultiBusinessPopup({ address, businesses }) {
  const activeCount = businesses.filter(b => 
    b.status === 'ACTIVE' || !b.permit_end
  ).length
  
  return (
    <div style={{ minWidth: '300px', maxWidth: '400px' }}>
      <h4 style={{ 
        marginBottom: '8px', 
        fontSize: '15px',
        borderBottom: '2px solid #007bff',
        paddingBottom: '5px'
      }}>
        {address}
      </h4>
      
      <div style={{ 
        fontSize: '12px', 
        color: '#666', 
        marginBottom: '15px',
        display: 'flex',
        justifyContent: 'space-between'
      }}>
        <span>
          {businesses.length} business{businesses.length !== 1 ? 'es' : ''} total
        </span>
        <span style={{ color: 'green', fontWeight: 'bold' }}>
          {activeCount} active
        </span>
      </div>
      
      <div style={{ 
        maxHeight: '400px', 
        overflowY: 'auto',
        marginTop: '10px'
      }}>
        {businesses.map((biz, i) => {
          const isActive = biz.status === 'ACTIVE' || !biz.permit_end
          
          return (
            <div key={i} style={{
              padding: '12px',
              marginBottom: '10px',
              backgroundColor: isActive ? '#f0f8ff' : '#f8f8f8',
              borderRadius: '6px',
              borderLeft: `4px solid ${isActive ? '#28a745' : '#dc3545'}`
            }}>
              <div style={{ 
                fontWeight: 'bold', 
                fontSize: '13px',
                marginBottom: '8px',
                color: '#333'
              }}>
                {biz.name}
              </div>
              
              <div style={{
                display: 'inline-block',
                padding: '3px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                fontWeight: 'bold',
                marginBottom: '8px',
                backgroundColor: isActive ? '#d4edda' : '#f8d7da',
                color: isActive ? '#155724' : '#721c24'
              }}>
                {isActive ? 'ACTIVE' : 'INACTIVE'}
              </div>
              
              <BusinessTimeline business={biz} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function App() {
  const [zipcode, setZipcode] = useState('')
  const [cachedZips, setCachedZips] = useState([])
  const [businesses, setBusinesses] = useState([])
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [geocodeProgress, setGeocodeProgress] = useState(null)
  const [mapCenter, setMapCenter] = useState([31.5, -99.5])
  const [mapZoom, setMapZoom] = useState(6)
  const [error, setError] = useState(null)
  const [ws, setWs] = useState(null)
  
  // Timeline state
  const [timelineEnabled, setTimelineEnabled] = useState(false)
  const [minDate, setMinDate] = useState(null)
  const [maxDate, setMaxDate] = useState(null)
  const [currentDate, setCurrentDate] = useState(null)

  // WebSocket connection
  useEffect(() => {
    const websocket = new WebSocket(WS_URL)
    
    websocket.onopen = () => {
      console.log('WebSocket connected')
    }
    
    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      
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
        
        if (data.zipcode === zipcode) {
          loadBusinesses(data.zipcode)
        }
      } else if (data.type === 'geocode_complete') {
        setGeocoding(false)
        setGeocodeProgress(null)
        
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
      const res = await axios.get(`${API_URL}/businesses/${zip}/timeline`)
      setBusinesses(res.data.businesses)
      
      // Set timeline range
      if (res.data.min_date && res.data.max_date) {
        setMinDate(res.data.min_date)
        setMaxDate(res.data.max_date)
        setCurrentDate(res.data.max_date) // Start at present
      }
      
      const firstGeocoded = res.data.businesses.find(b => b.lat && b.lon)
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

  // Filter businesses by timeline date
  const filteredBusinesses = timelineEnabled && currentDate
    ? businesses.filter(b => {
        const begin = b.begin_timestamp
        const end = b.end_timestamp
        return begin && begin <= currentDate && currentDate <= end
      })
    : businesses

  // Group businesses by address
  const businessesByAddress = filteredBusinesses.reduce((acc, biz) => {
    const key = `${biz.lat},${biz.lon}`
    if (!acc[key]) {
      acc[key] = {
        address: biz.address,
        lat: biz.lat,
        lon: biz.lon,
        businesses: []
      }
    }
    acc[key].businesses.push(biz)
    return acc
  }, {})

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
              checked={timelineEnabled}
              onChange={(e) => setTimelineEnabled(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            <span style={{ fontSize: '14px' }}>Enable Timeline Filter</span>
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
            <div>Showing: {Object.keys(businessesByAddress).length} locations</div>
            {timelineEnabled && (
              <div style={{ color: '#007bff', fontWeight: 'bold' }}>
                Filtered: {filteredBusinesses.length} businesses
              </div>
            )}
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

        {/* Timeline Slider */}
        {timelineEnabled && minDate && maxDate && (
          <TimelineSlider
            minDate={minDate}
            maxDate={maxDate}
            currentDate={currentDate}
            onDateChange={setCurrentDate}
            businesses={businesses}
          />
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

          {Object.entries(businessesByAddress)
            .filter(([_, data]) => data.lat && data.lon)
            .map(([coords, data]) => (
              <Marker
                key={coords}
                position={[data.lat, data.lon]}
              >
                <Popup maxWidth={450} maxHeight={500}>
                  <MultiBusinessPopup 
                    address={data.address}
                    businesses={data.businesses}
                  />
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>
    </div>
  )
}

export default App