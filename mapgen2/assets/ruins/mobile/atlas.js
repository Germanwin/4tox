/* мобильный атлас: половина кадров, ppu×0.5; см. build-mobile-atlases.py */
window.MOBILE_RUINS_ATLAS = {
 "atlas": "atlas.png",
 "ppu": 48.0,
 "az_deg": 45.0,
 "el_deg": 35.264389682754654,
 "res": [
  256,
  320
 ],
 "cell": [
  478,
  466
 ],
 "variants": {
  "townhall": [
   4,
   3
  ],
  "house": [
   2,
   3
  ],
  "lumbercamp": [
   3,
   3
  ],
  "barracks": [
   4,
   3
  ],
  "warcamp": [
   5,
   5
  ]
 },
 "mul": 0.7667,
 "types": {
  "townhall": {
   "ppu": 80.0,
   "mul": 0.7667,
   "footprint": [
    4,
    3
   ],
   "anchor": [
    215.0,
    268.0
   ],
   "ground": [
    -1.805,
    2.245,
    -1.321,
    1.946
   ],
   "source": "mapgen2/assets/townhall/atlas.json"
  },
  "house": {
   "ppu": 96.0,
   "mul": 0.7156,
   "footprint": [
    2,
    3
   ],
   "anchor": [
    366.0,
    486.0
   ],
   "ground": [
    -0.918,
    0.993,
    -1.484,
    1.492
   ],
   "source": "mapgen2/assets/starter_house/atlas.json"
  },
  "lumbercamp": {
   "ppu": 96.0,
   "mul": 0.7156,
   "footprint": [
    3,
    3
   ],
   "anchor": [
    355.0,
    389.0
   ],
   "ground": [
    -1.414,
    1.444,
    -1.449,
    1.266
   ],
   "source": "mapgen2/assets/lumbercamp/atlas.json"
  },
  "barracks": {
   "ppu": 96.0,
   "mul": 0.7667,
   "footprint": [
    4,
    3
   ],
   "anchor": [
    465.0,
    550.0
   ],
   "ground": [
    -2.014,
    1.998,
    -1.445,
    1.395
   ],
   "source": "mapgen2/assets/barracks/atlas.json"
  },
  "warcamp": {
   "ppu": 96.0,
   "mul": 0.7973,
   "footprint": [
    5,
    5
   ],
   "anchor": [
    250.0,
    351.0
   ],
   "ground": [
    -1.254,
    1.254,
    -1.254,
    1.254
   ],
   "source": "mapgen2/assets/warcamp/atlas.json"
  }
 },
 "note": "РУИНЫ пяти типов построек: 5 типов x 4 поворота = 20 кадров. variant — имя типа (townhall, house, lumbercamp, barracks, warcamp), кадры townhall_<поворот>..warcamp_<поворот>. anchorX/anchorY, ground, mul и footprint ПЕРЕНЕСЕНЫ из целых атласов (mapgen2/assets/<тип>/) и совпадают с ними — иначе подмена спрайта сдвинула бы руину. ВНИМАНИЕ: ppu и mul у типов разные (ратуша 80, остальные 96; mul 0.7156/0.7667/0.7973), поэтому у каждого кадра есть СВОИ ppu и mul, а блок types держит их по типу. Общие ppu=96 и mul=0.7667 — значения по умолчанию для совместимости, не для всех кадров. Кадр 512x640, истинная изометрия (az 45, el 35.2644), фон прозрачный, тени нет (правило 2026-10-17). Ни один кадр не выходит за своё пятно; ground нашего основания сверен с целым по модели (README, раздел «Что осталось неидеальным»).",
 "frames": {
  "townhall_0": {
   "x": 2,
   "y": 2,
   "w": 216,
   "h": 200,
   "anchorX": 107.5,
   "anchorY": 134.0,
   "variant": "townhall",
   "rotation": 0,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -1.805,
    2.245,
    -1.321,
    1.946
   ],
   "ppu": 80.0,
   "mul": 0.7667,
   "ppu_native": 80.0,
   "scale": 1
  },
  "townhall_90": {
   "x": 220,
   "y": 2,
   "w": 217,
   "h": 200,
   "anchorX": 108.0,
   "anchorY": 134.5,
   "variant": "townhall",
   "rotation": 90,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.429,
    1.928,
    -1.738,
    2.239
   ],
   "ppu": 80.0,
   "mul": 0.7667,
   "ppu_native": 80.0,
   "scale": 1
  },
  "townhall_180": {
   "x": 439,
   "y": 2,
   "w": 216,
   "h": 199,
   "anchorX": 108.0,
   "anchorY": 134.0,
   "variant": "townhall",
   "rotation": 180,
   "footprint": [
    4,
    3
   ],
   "ground": [
    -1.943,
    2.23,
    -1.42,
    1.862
   ],
   "ppu": 80.0,
   "mul": 0.7667,
   "ppu_native": 80.0,
   "scale": 1
  },
  "townhall_270": {
   "x": 657,
   "y": 2,
   "w": 217,
   "h": 199,
   "anchorX": 109.0,
   "anchorY": 134.0,
   "variant": "townhall",
   "rotation": 270,
   "footprint": [
    3,
    4
   ],
   "ground": [
    -1.502,
    1.854,
    -1.665,
    2.257
   ],
   "ppu": 80.0,
   "mul": 0.7667,
   "ppu_native": 80.0,
   "scale": 1
  },
  "house_0": {
   "x": 876,
   "y": 2,
   "w": 367,
   "h": 391,
   "anchorX": 183.0,
   "anchorY": 243.0,
   "variant": "house",
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
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "house_90": {
   "x": 1245,
   "y": 2,
   "w": 363,
   "h": 395,
   "anchorX": 182.0,
   "anchorY": 245.5,
   "variant": "house",
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
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "house_180": {
   "x": 2,
   "y": 399,
   "w": 367,
   "h": 395,
   "anchorX": 183.0,
   "anchorY": 245.5,
   "variant": "house",
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
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "house_270": {
   "x": 371,
   "y": 399,
   "w": 363,
   "h": 391,
   "anchorX": 180.5,
   "anchorY": 243.5,
   "variant": "house",
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
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "lumbercamp_0": {
   "x": 736,
   "y": 399,
   "w": 374,
   "h": 318,
   "anchorX": 177.5,
   "anchorY": 194.5,
   "variant": "lumbercamp",
   "rotation": 0,
   "footprint": [
    3,
    3
   ],
   "ground": [
    -1.414,
    1.444,
    -1.449,
    1.266
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "lumbercamp_90": {
   "x": 1112,
   "y": 399,
   "w": 331,
   "h": 357,
   "anchorX": 167.5,
   "anchorY": 218.5,
   "variant": "lumbercamp",
   "rotation": 90,
   "footprint": [
    3,
    3
   ],
   "ground": [
    -1.449,
    1.266,
    -1.444,
    1.414
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "lumbercamp_180": {
   "x": 1445,
   "y": 399,
   "w": 374,
   "h": 273,
   "anchorX": 196.0,
   "anchorY": 155.0,
   "variant": "lumbercamp",
   "rotation": 180,
   "footprint": [
    3,
    3
   ],
   "ground": [
    -1.444,
    1.414,
    -1.266,
    1.449
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "lumbercamp_270": {
   "x": 2,
   "y": 796,
   "w": 331,
   "h": 265,
   "anchorX": 162.5,
   "anchorY": 139.0,
   "variant": "lumbercamp",
   "rotation": 270,
   "footprint": [
    3,
    3
   ],
   "ground": [
    -1.266,
    1.449,
    -1.414,
    1.444
   ],
   "ppu": 96.0,
   "mul": 0.7156,
   "ppu_native": 96.0,
   "scale": 1
  },
  "barracks_0": {
   "x": 335,
   "y": 796,
   "w": 475,
   "h": 446,
   "anchorX": 232.5,
   "anchorY": 275.0,
   "variant": "barracks",
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
   ],
   "ppu": 96.0,
   "mul": 0.7667,
   "ppu_native": 96.0,
   "scale": 1
  },
  "barracks_90": {
   "x": 812,
   "y": 796,
   "w": 476,
   "h": 464,
   "anchorX": 242.0,
   "anchorY": 280.0,
   "variant": "barracks",
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
   ],
   "ppu": 96.0,
   "mul": 0.7667,
   "ppu_native": 96.0,
   "scale": 1
  },
  "barracks_180": {
   "x": 1290,
   "y": 796,
   "w": 475,
   "h": 443,
   "anchorX": 242.0,
   "anchorY": 260.0,
   "variant": "barracks",
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
   ],
   "ppu": 96.0,
   "mul": 0.7667,
   "ppu_native": 96.0,
   "scale": 1
  },
  "barracks_270": {
   "x": 2,
   "y": 1262,
   "w": 476,
   "h": 444,
   "anchorX": 233.0,
   "anchorY": 260.5,
   "variant": "barracks",
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
   ],
   "ppu": 96.0,
   "mul": 0.7667,
   "ppu_native": 96.0,
   "scale": 1
  },
  "warcamp_0": {
   "x": 480,
   "y": 1262,
   "w": 253,
   "h": 285,
   "anchorX": 125.0,
   "anchorY": 175.5,
   "variant": "warcamp",
   "rotation": 0,
   "footprint": [
    5,
    5
   ],
   "ground": [
    -1.254,
    1.254,
    -1.254,
    1.254
   ],
   "ppu": 96.0,
   "mul": 0.7973,
   "ppu_native": 96.0,
   "scale": 1
  },
  "warcamp_90": {
   "x": 735,
   "y": 1262,
   "w": 259,
   "h": 323,
   "anchorX": 128.0,
   "anchorY": 204.0,
   "variant": "warcamp",
   "rotation": 90,
   "footprint": [
    5,
    5
   ],
   "ground": [
    -1.254,
    1.254,
    -1.254,
    1.254
   ],
   "ppu": 96.0,
   "mul": 0.7973,
   "ppu_native": 96.0,
   "scale": 1
  },
  "warcamp_180": {
   "x": 996,
   "y": 1262,
   "w": 253,
   "h": 278,
   "anchorX": 128.0,
   "anchorY": 171.0,
   "variant": "warcamp",
   "rotation": 180,
   "footprint": [
    5,
    5
   ],
   "ground": [
    -1.254,
    1.254,
    -1.254,
    1.254
   ],
   "ppu": 96.0,
   "mul": 0.7973,
   "ppu_native": 96.0,
   "scale": 1
  },
  "warcamp_270": {
   "x": 1251,
   "y": 1262,
   "w": 259,
   "h": 237,
   "anchorX": 131.0,
   "anchorY": 140.5,
   "variant": "warcamp",
   "rotation": 270,
   "footprint": [
    5,
    5
   ],
   "ground": [
    -1.254,
    1.254,
    -1.254,
    1.254
   ],
   "ppu": 96.0,
   "mul": 0.7973,
   "ppu_native": 96.0,
   "scale": 1
  }
 },
 "mobile": true,
 "mobileScale": 0.5,
 "sourcePpu": 96.0
};
