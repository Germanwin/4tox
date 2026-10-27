/* мобильный атлас: половина кадров, ppu×0.5; см. build-mobile-atlases.py */
window.MOBILE_STARTER_HOUSE_ATLAS = {
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
   2,
   3
  ]
 },
 "mul": 0.7156,
 "note": "стартовый дом жителя: 1 юнит модели = 1 клетка карты, пятно 2 x 3 (при повороте 3 x 2); anchorX/anchorY — точка опоры (центр пятна застройки); footprint — пятно в клетках по повороту; ground — наземный контур (цоколь вместе с двором) в клетках от опоры, посчитан ПО МОДЕЛИ — цоколь недосложен, двор каменных столбцов не даёт, пиксельный замер видит только ближний край основания (см. шапку tools/pack_atlas.py); mul — крупность",
 "frames": {
  "sh_a_0": {
   "x": 2,
   "y": 2,
   "w": 367,
   "h": 391,
   "anchorX": 183.0,
   "anchorY": 243.0,
   "variant": "a",
   "rotation": 0,
   "footprint": [
    2,
    3
   ],
   "ground": [
    -0.918,
    0.993,
    -1.484,
    1.492
   ]
  },
  "sh_a_90": {
   "x": 371,
   "y": 2,
   "w": 363,
   "h": 395,
   "anchorX": 182.0,
   "anchorY": 245.5,
   "variant": "a",
   "rotation": 90,
   "footprint": [
    3,
    2
   ],
   "ground": [
    -1.484,
    1.492,
    -0.993,
    0.918
   ]
  },
  "sh_a_180": {
   "x": 736,
   "y": 2,
   "w": 367,
   "h": 395,
   "anchorX": 183.0,
   "anchorY": 245.5,
   "variant": "a",
   "rotation": 180,
   "footprint": [
    2,
    3
   ],
   "ground": [
    -0.993,
    0.918,
    -1.492,
    1.484
   ]
  },
  "sh_a_270": {
   "x": 1105,
   "y": 2,
   "w": 363,
   "h": 391,
   "anchorX": 180.5,
   "anchorY": 243.5,
   "variant": "a",
   "rotation": 270,
   "footprint": [
    3,
    2
   ],
   "ground": [
    -1.492,
    1.484,
    -0.918,
    0.993
   ]
  }
 },
 "mobile": true,
 "mobileScale": 0.5,
 "sourcePpu": 96.0
};
