/* мобильный атлас: половина кадров, ppu×0.5; см. build-mobile-atlases.py */
window.MOBILE_BARRACKS_ATLAS = {
 "atlas": "atlas.png",
 "ppu": 48.0,
 "az_deg": 45.0,
 "el_deg": 35.264389682754654,
 "res": [
  256,
  320
 ],
 "variants": {
  "a": [
   4,
   3
  ],
  "b": [
   4,
   3
  ]
 },
 "mul": 0.7667,
 "note": "спрайты казармы: 1 юнит модели = 1 клетка карты; пятно 4 x 3 (при 90/270 — 3 x 4); два варианта: a — открытый плац, b — двор с навесом. anchorX/anchorY — точка опоры (центр пятна); footprint — пятно в клетках по повороту; ground — наземный контур в клетках от опоры, посчитан ПО МОДЕЛИ (основание — валуны плюс разреженный плац, пиксельный замер видит только ближний край; см. шапку tools/pack_barracks.py); mul — крупность siteMul(4) = 0.7667, как у ратуши",
 "frames": {
  "br_a_0": {
   "x": 2,
   "y": 2,
   "w": 475,
   "h": 446,
   "anchorX": 232.5,
   "anchorY": 275.0,
   "variant": "a",
   "rotation": 0,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -2.014,
    1.998,
    -1.445,
    1.395
   ]
  },
  "br_a_90": {
   "x": 479,
   "y": 2,
   "w": 476,
   "h": 464,
   "anchorX": 242.0,
   "anchorY": 280.0,
   "variant": "a",
   "rotation": 90,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.445,
    1.395,
    -1.998,
    2.014
   ]
  },
  "br_a_180": {
   "x": 957,
   "y": 2,
   "w": 475,
   "h": 443,
   "anchorX": 242.0,
   "anchorY": 260.0,
   "variant": "a",
   "rotation": 180,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -1.998,
    2.014,
    -1.395,
    1.445
   ]
  },
  "br_a_270": {
   "x": 1434,
   "y": 2,
   "w": 476,
   "h": 444,
   "anchorX": 233.0,
   "anchorY": 260.5,
   "variant": "a",
   "rotation": 270,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.395,
    1.445,
    -2.014,
    1.998
   ]
  },
  "br_b_0": {
   "x": 2,
   "y": 468,
   "w": 494,
   "h": 446,
   "anchorX": 246.5,
   "anchorY": 275.0,
   "variant": "b",
   "rotation": 0,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -2.014,
    1.998,
    -1.445,
    1.444
   ]
  },
  "br_b_90": {
   "x": 498,
   "y": 468,
   "w": 476,
   "h": 474,
   "anchorX": 242.0,
   "anchorY": 282.5,
   "variant": "b",
   "rotation": 90,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.445,
    1.444,
    -1.998,
    2.014
   ]
  },
  "br_b_180": {
   "x": 976,
   "y": 468,
   "w": 494,
   "h": 443,
   "anchorX": 247.0,
   "anchorY": 260.0,
   "variant": "b",
   "rotation": 180,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -1.998,
    2.014,
    -1.444,
    1.445
   ]
  },
  "br_b_270": {
   "x": 1472,
   "y": 468,
   "w": 476,
   "h": 444,
   "anchorX": 233.0,
   "anchorY": 260.5,
   "variant": "b",
   "rotation": 270,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.444,
    1.445,
    -2.014,
    1.998
   ]
  }
 },
 "mobile": true,
 "mobileScale": 0.5,
 "sourcePpu": 96.0
};
