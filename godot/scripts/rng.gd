class_name ToxRNG
extends RefCounted

## Deterministic PRNG — a direct port of mapgen2/js/rng.js.
## The same seed gives the same island in the browser game and in Godot.

var seed: int = 0
var _state: int = 0

static func imul(a: int, b: int) -> int:
	# JavaScript Math.imul: low 32 bits of a two's-complement product.
	a &= 0xFFFFFFFF
	b &= 0xFFFFFFFF
	var ah := a >> 16
	var al := a & 0xFFFF
	var bh := b >> 16
	var bl := b & 0xFFFF
	var lo := al * bl
	var mid := ((ah * bl + al * bh) & 0xFFFF) << 16
	return (lo + mid) & 0xFFFFFFFF

static func hash_string(text: String) -> int:
	var h := 2166136261
	for i in range(text.length()):
		h ^= text.unicode_at(i)
		h = imul(h, 16777619)
	return h & 0xFFFFFFFF

func _init(p_seed: Variant = 0) -> void:
	if typeof(p_seed) == TYPE_INT:
		seed = int(p_seed) & 0xFFFFFFFF
	else:
		seed = hash_string(str(p_seed))
	_state = seed

func next_float() -> float:
	_state = (_state + 0x6D2B79F5) & 0xFFFFFFFF
	var t := imul(_state ^ (_state >> 15), 1 | _state)
	t = ((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
	return float((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

func range_f(a: float, b: float) -> float:
	return a + (b - a) * next_float()

func range_i(a: int, b: int) -> int:
	return a + int(floor(next_float() * float(b - a + 1)))

func chance(p: float) -> bool:
	return next_float() < p

func pick(items: Array) -> Variant:
	if items.is_empty():
		return null
	return items[mini(items.size() - 1, int(floor(next_float() * items.size())))]

func sign() -> int:
	return -1 if next_float() < 0.5 else 1

func weighted(weights: PackedFloat32Array) -> int:
	var total := 0.0
	for w in weights:
		total += w
	var r := next_float() * total
	for i in range(weights.size()):
		r -= weights[i]
		if r <= 0.0:
			return i
	return weights.size() - 1

func get_state() -> Dictionary:
	return {"seed": seed, "state": _state}

static func from_state(data: Dictionary) -> ToxRNG:
	var r := ToxRNG.new(int(data.get("seed", 0)))
	r._state = int(data.get("state", 0)) & 0xFFFFFFFF
	return r

const ADJ := ["тихая", "зелёная", "каменная", "мокрая", "северная", "кривая", "старая",
	"новая", "дикая", "вольная", "тенистая", "туманная", "звонкая", "рыжая", "студёная"]
const NOUN := ["долина", "заводь", "бор", "брод", "перевал", "плесо", "яруга", "грива",
	"падь", "косогор", "исток", "лукоморье", "взгорье", "согра", "пойма"]

static func random_seed() -> String:
	var r := ToxRNG.new(int(Time.get_unix_time_from_system() * 1000.0 + randf() * 4294967295.0))
	return str(r.pick(ADJ)) + "-" + str(r.pick(NOUN)) + "-" + str(r.range_i(100, 999))
