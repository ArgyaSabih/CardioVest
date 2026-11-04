import { num } from "./labels.js";

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createMap(box, empty, meta) {
  let map = null;
  let marker = null;
  let circle = null;

  function clear() {
    if (!map) return;
    map.remove();
    map = marker = circle = null;
    box.className = "map";
    box.textContent = "";
    box.append(empty);
  }

  function waiting(mode) {
    clear();
    empty.textContent = mode === "test" ? "Menunggu lokasi" : "Aktif saat Darurat";
    meta.textContent = "–";
  }

  return {
    idle(mode) {
      if (!map) waiting(mode);
    },
    show(g, mode) {
      if (!g || !g.active || !g.fix) return waiting(mode);
      meta.innerHTML = "";
      const a = document.createElement("a");
      a.href = `https://www.google.com/maps?q=${g.lat},${g.lon}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${num(g.lat, 6)}, ${num(g.lon, 6)}`;
      meta.append(a, g.accuracy_m != null ? ` ±${num(g.accuracy_m)} m` : "");
      if (!window.L) return;
      if (!map) {
        box.textContent = "";
        box.className = "map-leaflet";
        map = L.map(box).setView([g.lat, g.lon], 18);
        const opt = { subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 20, attribution: "&copy; Google" };
        const road = L.tileLayer("https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", opt).addTo(map);
        const sat = L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", opt);
        const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" });
        L.control.layers({ Peta: road, Satelit: sat, OpenStreetMap: osm }).addTo(map);
        const color = cssVar("--crit");
        marker = L.circleMarker([g.lat, g.lon], { radius: 7, weight: 2, color, fillColor: color, fillOpacity: 0.9 }).addTo(map);
        circle = L.circle([g.lat, g.lon], { radius: g.accuracy_m ?? 5, color }).addTo(map);
      } else {
        marker.setLatLng([g.lat, g.lon]);
        circle.setLatLng([g.lat, g.lon]).setRadius(g.accuracy_m ?? 5);
      }
    },
  };
}
