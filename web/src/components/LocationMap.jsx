'use client';
// Peta lokasi (Leaflet + OpenStreetMap). Titik terakhir ditandai, jejak lokasi digambar tipis.
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useRef } from 'react';

export default function LocationMap({ lat, lng, acc, trail = [], height = 260 }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([lat, lng], 17);
    const google = { subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], maxZoom: 20, attribution: '&copy; Google' };
    const road = L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', google).addTo(map.current);
    const sat = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', google);
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    L.control.layers({ 'Google Maps': road, 'Google Satelit': sat, OpenStreetMap: osm }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = layer.current;
    g.clearLayers();
    if (trail.length > 1) L.polyline(trail.map((p) => [p.lat, p.lng]), { color: '#14213D', weight: 3, opacity: 0.55 }).addTo(g);
    if (acc) L.circle([lat, lng], { radius: acc, color: '#C8102E', weight: 1, fillOpacity: 0.12 }).addTo(g);
    L.circleMarker([lat, lng], { radius: 9, color: '#FFFFFF', weight: 3, fillColor: '#C8102E', fillOpacity: 1 }).addTo(g);
    map.current.panTo([lat, lng]);
  }, [lat, lng, acc, trail]);

  return <div ref={el} className="map" style={{ height }} role="region" aria-label="Peta lokasi pengguna" />;
}
