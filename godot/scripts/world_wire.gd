class_name ToxWorldWire
extends RefCounted

## Decoder for the server's one-time static world (game/shared/world-wire.js,
## WLD1). Fills a ToxWorldData so the renderer treats a live room exactly like
## the fixture: the client never generates an island itself.

const KINDS := ["tree", "bush", "tuft", "flower", "stone", "reed"]
const VARIANTS := [null, "oak", "pine", "birch", "autumn", "pebble", "boulder",
	"rock", "iron", "salt", "f1", "f2", "f3"]
const MAGIC := 0x31444C57
const VERSION := 1


class Reader:
	extends RefCounted
	var data: PackedByteArray
	var pos := 0
	var err := ""

	func _init(d: PackedByteArray) -> void:
		data = d

	func need(n: int) -> bool:
		if err != "":
			return false
		if pos + n > data.size():
			err = "мир: кадр короче"
			return false
		return true

	func u8() -> int:
		if not need(1):
			return 0
		var v := data[pos]
		pos += 1
		return v

	func u16() -> int:
		if not need(2):
			return 0
		var v := data.decode_u16(pos)
		pos += 2
		return v

	func u32() -> int:
		if not need(4):
			return 0
		var v := data.decode_u32(pos)
		pos += 4
		return v

	func raw(n: int) -> PackedByteArray:
		if not need(n):
			return PackedByteArray()
		var out := data.slice(pos, pos + n)
		pos += n
		return out

	func text(n: int) -> String:
		return raw(n).get_string_from_utf8()


## Returns {"ok": true} or {"ok": false, "error": "..."}.
static func unpack_into(target, bytes: PackedByteArray) -> Dictionary:
	var r := Reader.new(bytes)
	if r.u32() != MAGIC:
		return {"ok": false, "error": "мир: не WLD1"}
	if r.u8() != VERSION:
		return {"ok": false, "error": "мир: версия"}
	var w := r.u16()
	var h := r.u16()
	var isl := r.u16()
	var seed := r.text(r.u16())
	var hash := r.text(r.u8())
	if w <= 0 or h <= 0:
		return {"ok": false, "error": "мир: пустые размеры"}
	var n := w * h
	target.width = w
	target.height = h
	target.island_size = isl
	target.seed = seed
	target.worldgen_hash = hash
	target.tile = r.raw(n)
	target.is_land = r.raw(n)
	var dl := PackedFloat32Array()
	dl.resize(n)
	for i in range(n):
		dl[i] = float(r.u16()) / 100.0
	var dw := PackedFloat32Array()
	dw.resize(n)
	for i in range(n):
		dw[i] = float(r.u16()) / 100.0
	target.dist_land = dl
	target.dist_water = dw
	var count := r.u32()
	var objects: Array = []
	objects.resize(count)
	for i in range(count):
		var kind_id := r.u8()
		var variant_id := r.u8()
		objects[i] = {
			"kind": KINDS[kind_id] if kind_id < KINDS.size() else "tree",
			"variant": VARIANTS[variant_id] if variant_id < VARIANTS.size() else null,
			"x": float(r.u16()) / 100.0,
			"y": float(r.u16()) / 100.0,
			"scale": float(r.u16()) / 1000.0,
			"phase": float(r.u16()) / 1000.0,
			"id": r.u16()
		}
	target.objects = objects
	if r.err != "":
		return {"ok": false, "error": r.err}
	if r.pos != bytes.size():
		return {"ok": false, "error": "мир: лишние байты"}
	return {"ok": true}
