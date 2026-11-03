class_name ToxNoise
extends RefCounted

## Value-noise + fBm — direct port of mapgen2/js/noise.js.

static func hash2i(x: int, y: int, seed_value: int) -> float:
	var h := ToxRNG.imul(x, 0x27d4eb2d) ^ ToxRNG.imul(y, 0x165667b1) ^ ToxRNG.imul(seed_value, 0x9e3779b1)
	h &= 0xFFFFFFFF
	h = ToxRNG.imul(h ^ (h >> 15), 0x85ebca6b)
	h = ToxRNG.imul(h ^ (h >> 13), 0xc2b2ae35)
	h ^= h >> 16
	return float(h & 0xFFFFFFFF) / 4294967296.0

static func fade(t: float) -> float:
	return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)

static func value2(x: float, y: float, seed_value: int) -> float:
	var xi := int(floor(x))
	var yi := int(floor(y))
	var xf := x - float(xi)
	var yf := y - float(yi)
	var u := fade(xf)
	var v := fade(yf)
	var a := hash2i(xi, yi, seed_value)
	var b := hash2i(xi + 1, yi, seed_value)
	var c := hash2i(xi, yi + 1, seed_value)
	var d := hash2i(xi + 1, yi + 1, seed_value)
	var top := a + (b - a) * u
	var bot := c + (d - c) * u
	return top + (bot - top) * v

static func fbm2(x: float, y: float, seed_value: int, oct: int = 4, lac: float = 2.0, gain: float = 0.5) -> float:
	var amp := 1.0
	var freq := 1.0
	var total := 0.0
	var norm := 0.0
	for i in range(oct):
		total += amp * value2(x * freq, y * freq, seed_value + i * 1013)
		norm += amp
		amp *= gain
		freq *= lac
	return total / norm

static func ridged2(x: float, y: float, seed_value: int, oct: int = 4, lac: float = 2.0, gain: float = 0.5) -> float:
	var amp := 1.0
	var freq := 1.0
	var total := 0.0
	var norm := 0.0
	for i in range(oct):
		var v := value2(x * freq, y * freq, seed_value + i * 7919)
		var r := 1.0 - absf(v * 2.0 - 1.0)
		total += amp * r * r
		norm += amp
		amp *= gain
		freq *= lac
	return total / norm
