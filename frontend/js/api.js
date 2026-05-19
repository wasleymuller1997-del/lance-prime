const API_URL = window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : '/api';

function authHeaders() {
  var token = localStorage.getItem('lp_token');
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

const api = {
  async getEvents() {
    const res = await fetch(`${API_URL}/events`);
    return res.json();
  },

  async getEventVehicles(eventId) {
    const res = await fetch(`${API_URL}/events/${eventId}/vehicles`);
    return res.json();
  },

  async getEventDetails(eventId) {
    const res = await fetch(`${API_URL}/events/${eventId}`);
    return res.json();
  },

  async getOffers(advertisementId) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/offers`);
    return res.json();
  },

  async placeBid(advertisementId, value, brand, model, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/bid`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ value, brand: brand || '', model: model || '', vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async placeAutoBid(advertisementId, maxValue, tiebreaker = false, brand, model, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/auto-bid`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ maxValue, tiebreaker, brand: brand || '', model: model || '', vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async buyNow(advertisementId, value, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/buy-now`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ value, vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async getFipeValue(brand, model, version, year) {
    const params = new URLSearchParams({ brand, model, version: version || '', year });
    const res = await fetch(`${API_URL}/fipe/valor?${params}`);
    return res.json();
  },

  async toggleFavorite(advertisementId) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/favorite`, {
      method: 'POST'
    });
    return res.json();
  },

  async getMyOffers() {
    const res = await fetch(`${API_URL}/my-offers`);
    return res.json();
  }
};
