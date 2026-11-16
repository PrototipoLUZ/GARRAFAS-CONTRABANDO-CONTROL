/* ===== AJUSTES ===== */
const DB = "https://gps-esp34-default-rtdb.firebaseio.com";
const AJ = { cadaMs: 4000, obsoletoS: 20 };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const get = async p => (await fetch(DB + p, { cache: "no-store" })).json();
const put = (p, d) => fetch(DB + p, { method: "PUT", body: JSON.stringify(d) });
const parsePts = s => (s || "").split(";").filter(Boolean).map(p => p.split(",").map(Number));
const ptsStr = a => a.map(p => p[0].toFixed(6) + "," + p[1].toFixed(6)).join(";");
const fecha = ts => new Date(ts).toLocaleString("es-BO");

/* ===== Mapa ===== */
const mapa = L.map("mapa", { zoomControl: false }).setView([-16.51, -68.19], 13);
L.control.zoom({ position: "topright" }).addTo(mapa);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(mapa);

let vehs = {}, pos = {}, alertas = [], sel = null, dibujando = false, borrador = [];
const marcas = {}, rutas = {};
const borr = L.polyline([], { color: "#f0a400", weight: 5, dashArray: "8 8" }).addTo(mapa);
const borrPts = L.layerGroup().addTo(mapa);

/* ===== Panel lateral ===== */
function abrir(si) { $("lateral").classList.toggle("abierto", si); $("menu").setAttribute("aria-expanded", si); }
$("menu").onclick = () => abrir(!$("lateral").classList.contains("abierto"));
abrir(window.innerWidth >= 700);
const aviso = t => { $("aviso").textContent = t; };

/* ===== Trazado de la ruta (punto A a punto B) ===== */
function pintarBorrador() {
  borr.setLatLngs(borrador);
  borrPts.clearLayers();
  borrador.forEach((p, i) => {
    const m = L.circleMarker(p, { radius: 6, color: "#fff", weight: 2, fillColor: "#f0a400", fillOpacity: 1 }).addTo(borrPts);
    if (i === 0) m.bindTooltip("A", { permanent: true, direction: "top" });
    else if (i === borrador.length - 1) m.bindTooltip("B", { permanent: true, direction: "top" });
  });
}
mapa.on("click", e => {
  if (!dibujando) return;
  borrador.push([e.latlng.lat, e.latlng.lng]); pintarBorrador();
});
$("trazar").onclick = () => {
  dibujando = !dibujando;
  $("trazar").classList.toggle("activo", dibujando);
  $("trazar").textContent = dibujando ? "Terminar de trazar" : "Trazar ruta en el mapa";
  if (dibujando) { aviso("Toca el mapa: primer punto = A, último punto = B. Sigue las calles."); if (window.innerWidth < 700) abrir(false); }
};
$("deshacer").onclick = () => { borrador.pop(); pintarBorrador(); };
$("borrar").onclick = () => { borrador = []; pintarBorrador(); };

function llenar(id) {
  const v = id ? vehs[id] : null;
  $("vId").value = id || ""; $("vId").disabled = !!id;
  $("vPlaca").value = v ? v.placa || "" : ""; $("vResp").value = v ? v.responsable || "" : "";
  $("vTel").value = v ? v.telefono || "" : "";
  $("vAncho").value = v ? v.ancho || 40 : 40; $("vGracia").value = v ? v.gracia || 120 : 120;
  borrador = v ? parsePts(v.pts) : []; pintarBorrador(); aviso("");
}
$("nuevo").onclick = () => { sel = null; llenar(null); render(); };

$("guardar").onclick = async () => {
  const id = $("vId").value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,20}$/.test(id)) return aviso("El ID debe tener de 2 a 20 letras minúsculas o números.");
  if (!$("vPlaca").value.trim() || !$("vResp").value.trim()) return aviso("Completa la placa y el responsable.");
  if (borrador.length < 2) return aviso("Marca al menos el punto A y el punto B en el mapa.");
  if (borrador.length > 40) return aviso("Máximo 40 puntos por ruta.");
  const d = {
    placa: $("vPlaca").value.trim(), responsable: $("vResp").value.trim(), telefono: $("vTel").value.trim(),
    ancho: Math.max(10, Number($("vAncho").value) || 40), gracia: Math.max(10, Number($("vGracia").value) || 120),
    pts: ptsStr(borrador)
  };
  try {
    await put("/vehiculos/" + id + ".json", d);
    aviso("Guardado. El equipo leerá la ruta en unos segundos.");
    dibujando = false; $("trazar").classList.remove("activo"); $("trazar").textContent = "Trazar ruta en el mapa";
    sel = id; $("vId").disabled = true; cargar();
  } catch (e) { aviso("No se pudo guardar. Revisa la conexión."); }
};

/* ===== Estado de cada vehículo ===== */
function est(id) {
  const p = pos[id], v = vehs[id] || {};
  if (!p) return { t: "Sin datos del equipo", c: "nd" };
  const edad = Math.round((Date.now() - p.ts) / 1000);
  if (edad > AJ.obsoletoS) return { t: "Sin señal hace " + edad + " s", c: "nd" };
  if (p.estado == 2) return { t: "ALERTA: fuera de ruta", c: "alerta" };
  if (p.estado == 1) return { t: "Advertencia: debe volver en " + Math.max(0, (v.gracia || 0) - (p.fuera_s || 0)) + " s", c: "adv" };
  return { t: "En ruta", c: "ok" };
}

/* ===== Dibujo ===== */
function render() {
  const ids = Object.keys(vehs);
  $("lista").innerHTML = ids.length ? "" : '<p class="nota">Aún no hay vehículos registrados.</p>';
  let alerta = null, vivo = false;

  ids.forEach(id => {
    const v = vehs[id], e = est(id);
    if (e.c !== "nd") vivo = true;
    if (e.c === "alerta" && !alerta) alerta = { id, v };
    const b = document.createElement("button");
    b.className = "veh " + e.c + (id === sel ? " sel" : "");
    b.innerHTML = "<strong>" + esc(v.placa) + " · " + esc(id) + "</strong><span>" + esc(e.t) + "</span><span>Responsable: " + esc(v.responsable) + "</span>";
    b.onclick = () => { sel = id; llenar(id); if (pos[id]) mapa.setView([pos[id].lat, pos[id].lng], 16); render(); };
    $("lista").appendChild(b);

    const pts = parsePts(v.pts);
    if (pts.length > 1) {
      if (!rutas[id]) rutas[id] = L.polyline(pts, { color: "#1f5eff", weight: 4, opacity: .6 }).addTo(mapa);
      rutas[id].setLatLngs(pts); rutas[id].setStyle({ weight: id === sel ? 6 : 4, opacity: id === sel ? .9 : .5 });
    }
    if (pos[id]) {
      const ll = [pos[id].lat, pos[id].lng];
      const ic = L.divIcon({ className: "pin " + e.c, html: "<span></span>", iconSize: [30, 30] });
      if (!marcas[id]) marcas[id] = L.marker(ll, { icon: ic }).addTo(mapa);
      marcas[id].setLatLng(ll).setIcon(ic).bindTooltip(esc(v.placa), { direction: "top", offset: [0, -12] });
    }
  });

  const banner = $("alarma");
  if (alerta) {
    banner.hidden = false;
    banner.innerHTML = "ALERTA · Vehículo " + esc(alerta.v.placa) + " fuera de la ruta establecida<br>Responsable: " + esc(alerta.v.responsable) + " · Tel: " + esc(alerta.v.telefono || "—");
  } else banner.hidden = true;
  document.body.classList.toggle("hay-alarma", !!alerta);

  $("chip").className = "chip " + (vivo ? "ok" : "mal");
  $("estado").textContent = vivo ? "En vivo" : "Sin señal de equipos";

  $("alertas").innerHTML = alertas.length ? "" : '<p class="nota">Sin alertas.</p>';
  alertas.forEach(a => {
    const v = vehs[a.id] || {};
    const d = document.createElement("div");
    d.className = "alerta";
    d.innerHTML = "<strong>" + esc(fecha(a.ts)) + "</strong><span>Vehículo: " + esc(v.placa || a.id) +
      " · Se salió " + Math.round(a.desv || 0) + " m de la ruta</span><span>Responsable: " + esc(v.responsable || "—") +
      " · Tel: " + esc(v.telefono || "—") + "</span>";
    $("alertas").appendChild(d);
  });
}

async function cargar() {
  try {
    const [v, p, a] = await Promise.all([
      get("/vehiculos.json"), get("/pos.json"),
      get('/alertas.json?orderBy=%22$key%22&limitToLast=20')
    ]);
    vehs = v || {}; pos = p || {};
    alertas = Object.values(a || {}).sort((x, y) => y.ts - x.ts);
  } catch (e) { $("chip").className = "chip mal"; $("estado").textContent = "Sin conexión"; return; }
  render();
}
cargar();
setInterval(cargar, AJ.cadaMs);
