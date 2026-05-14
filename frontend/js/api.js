const API_URL = window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : '/api';

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

  async placeBid(advertisementId, value) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/bid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    return res.json();
  },

  async placeAutoBid(advertisementId, maxValue, tiebreaker = false) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/auto-bid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxValue, tiebreaker })
    });
    return res.json();
  },

  async buyNow(advertisementId, value) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/buy-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    return res.json();
  },

  async getFipeValue(brand, model, version, year) {
    const params = new URLSearchParams({ brand, model, version: version || '', year });
    const res = await fetch(`${API_URL}/fipe/valor?${params}`);
    return res.json();
  }
};
