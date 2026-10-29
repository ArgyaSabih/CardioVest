import { num } from "./labels.js";

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createMap(box, empty, meta) {
  let map = null;
  let marker = null;
  let circle = null;

  function waiting(text, metaText) {
    if (map) return;
    empty.textContent = text;
    meta.textContent = metaText;
  }

  return {
    idle(mode) {
      waiting(
        mode === "test"
          ? "Mode Test: GPS menyala terus. Lokasi muncul begitu modul mendapat sinyal satelit."
          : "Mode Demo: GPS hanya dinyalakan saat status Darurat.",
        "Siaga",
      );
    },
    show(g) {
      if (!g) return;
      if (!g.fix) {
        if (g.nmea === false) {
          waiting(
            "Modul GPS tidak mengirim data. Periksa kabel: TX GPS ke GPIO19, RX GPS ke GPIO18, VCC ke 3V3/5V, GND ke GND.",
            `Tidak ada data NMEA, baud ${g.baud ?? "?"}`,
          );
        } else {
          waiting(
            `Mencari satelit (${g.sats ?? 0} terlihat). Letakkan alat di luar ruangan atau dekat jendela.`,
            `Mencari satelit, ${g.sats ?? 0} terlihat`,
          );
        }
        return;
      }
      const link = `https://www.google.com/maps?q=${g.lat},${g.lon}`;
      meta.innerHTML = "";
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${num(g.lat, 6)}, ${num(g.lon, 6)}`;
      meta.append(a, ` ±${num(g.accuracy_m)} m, ${g.sats} satelit`);
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
        circle = L.circle([g.lat, g.lon], { radius: g.accuracy_m, color }).addTo(map);
      } else {
        marker.setLatLng([g.lat, g.lon]);
        circle.setLatLng([g.lat, g.lon]).setRadius(g.accuracy_m);
        map.panTo([g.lat, g.lon]);
      }
    },
  };
}
