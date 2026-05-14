const API_URL = 'http://localhost:3001/api';

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
  }
};
