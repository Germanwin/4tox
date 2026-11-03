/* fill.js — кусок JS, который вставляется В СТРАНИЦУ игры и наполняет мир
   жителями. Читается как текст (require('fs')), а не как модуль: это код для
   браузера, не для Node.

   Тот же приём, что у серверной приёмки (game/server/room-runtime.js:
   debugFill): Villagers.blank, кольцами вокруг ратуши, состояние «гуляет».
   Мир остаётся настоящим — те же жители, тот же шаг, та же отрисовка. */
function fill(n) {
  const P = window.__game.Play, st = P.state, w = st.world;
  const town = w.towns && w.towns[0], hall = town && town.townhall;
  const cx = hall ? hall.x + 1.5 : w.width / 2, cy = hall ? hall.y + 1.5 : w.height / 2;
  const solid = window.Villagers.blockedMap ? window.Villagers.blockedMap(w, st.buildings) : null;
  const spots = [];
  for (let r = 2; r <= Math.max(w.width, w.height) / 2 && spots.length < 2000; r += 2) {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(w.height - 1, cy + r); y += 2) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w.width - 1, cx + r); x += 2) {
        if (!w.isLand || !w.isLand[y * w.width + x]) continue;
        if (solid && solid[y * w.width + x]) continue;
        spots.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
  }
  if (!spots.length) return 0;
  const baseId = 90000 + (st.villagers.length * 7) % 10000;
  let made = 0;
  for (let i = 0; i < n; i++) {
    const s = spots[i % spots.length], vid = baseId + i;
    let v;
    try {
      v = window.Villagers.blank(w, {
        id: vid, index: vid, rngKey: vid, x: s.x, y: s.y,
        owner: 0, town: 0, avoid: st.villagers, buildings: st.buildings
      });
    } catch (e) { return made; }
    v.state = 'wander'; v.path = null; v.anchor = { x: s.x, y: s.y }; v.avoid = [];
    st.villagers.push(v);
    made++;
  }
  w._villagers = st.villagers;
  P.renderer().setVillagers(st.villagers);
  return made;
}
