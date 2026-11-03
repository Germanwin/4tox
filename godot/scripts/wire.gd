class_name ToxWire
extends RefCounted

## Decoder for the room server's binary world frame (game/shared/net-wire.js, v2).
## Keeps the same field names and units as the JS unpacker, so a frame and the
## server's JSON baseline can be compared field by field in tests.
##
## No game rules live here: this is transport, not simulation.

const MAGIC := 0x31585434          # "4TX1" little-endian
const VERSION := 2
const TYPE_SNAPSHOT := 1
const NULL_STR := 0xFFFF
const F_BASELINE := 1
const F_RESULTS := 2

const VF := {
	"FROZEN": 1 << 0, "WARRIOR": 1 << 1, "TRAINEE": 1 << 2, "HIDDEN": 1 << 3,
	"CARRYING": 1 << 4, "DEAD": 1 << 5, "TELEPORT": 1 << 6,
	"HP": 1 << 7, "HP_UNTIL": 1 << 8, "FLINCH": 1 << 9, "ATTACK_T": 1 << 10,
	"TRAINING": 1 << 11, "HOME": 1 << 12, "EMPLOYER": 1 << 13, "CAMP": 1 << 14,
	"STATION": 1 << 15, "APPEAR": 1 << 16, "VANISH": 1 << 17, "EMERGE": 1 << 18,
	"ORDER": 1 << 19, "DEATH": 1 << 20, "SAFE": 1 << 21, "PHASE": 1 << 22,
	"ANIM": 1 << 23, "STATE": 1 << 24, "OWNER": 1 << 25, "TOWN": 1 << 26
}


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
			err = "кадр короче: нужно %d байт, осталось %d" % [n, data.size() - pos]
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

	func i32() -> int:
		if not need(4):
			return 0
		var v := data.decode_s32(pos)
		pos += 4
		return v

	func f32() -> float:
		if not need(4):
			return 0.0
		var v := data.decode_float(pos)
		pos += 4
		return v

	func f64() -> float:
		if not need(8):
			return 0.0
		var v := data.decode_double(pos)
		pos += 8
		return v

	func varint() -> int:
		var v := 0
		var shift := 0
		while true:
			var b := u8()
			if err != "":
				return 0
			v += (b & 0x7F) << shift
			shift += 7
			if (b & 0x80) == 0:
				break
			if shift > 35:
				err = "слишком длинный varint"
				return 0
		return v

	func raw(n: int) -> PackedByteArray:
		if not need(n):
			return PackedByteArray()
		var out := data.slice(pos, pos + n)
		pos += n
		return out

	func str() -> String:
		var n := varint()
		return raw(n).get_string_from_utf8()


## Returns {"ok": true, "snapshot": {...}} or {"ok": false, "error": "..."}.
static func unpack(bytes: PackedByteArray) -> Dictionary:
	var r := Reader.new(bytes)

	if r.u32() != MAGIC:
		return {"ok": false, "error": "не кадр 4tox (magic)"}
	var version := r.u8()
	if version != 1 and version != VERSION:
		return {"ok": false, "error": "версия кадра %d" % version}
	if r.u8() != TYPE_SNAPSHOT:
		return {"ok": false, "error": "тип кадра не снимок"}
	var flags := r.u16()

	var nstr := r.varint()
	if nstr > 65535:
		return {"ok": false, "error": "таблица строк слишком велика"}
	var strings: Array = []
	strings.resize(nstr)
	for i in range(nstr):
		strings[i] = r.str()
	if r.err != "":
		return {"ok": false, "error": r.err}

	var out := {}
	out["protocol"] = r.u8()
	out["size"] = r.u16()
	out["epoch"] = r.u32()
	out["revision"] = r.u32()
	out["seq"] = out["revision"]
	out["simulationTick"] = r.u32()
	out["simulationTimeMs"] = r.u32()
	out["serverGeneratedAtMs"] = r.f64()
	out["structureVersion"] = r.u32()
	out["over"] = r.u8() != 0
	var win := r.i32()
	if win != -2:
		out["winner"] = -1 if win < 0 else win
	out["objectTotal"] = r.u32()
	out["roomId"] = _str_at(strings, r.u16())
	out["worldgenVersion"] = _str_at(strings, r.u16())
	out["worldgenHash"] = _str_at(strings, r.u16())
	out["gameplayConfigHash"] = _str_at(strings, r.u16())
	out["seed"] = _str_at(strings, r.u16())
	out["roomStatus"] = _str_at(strings, r.u16())
	out["removed"] = r.str()
	if flags & F_BASELINE:
		out["baseline"] = true
	if r.err != "":
		return {"ok": false, "error": r.err}

	var towns: Array = []
	var nt := r.varint()
	for t in range(nt):
		var tw := {
			"id": r.u16(), "owner": r.u8(),
			"name": _str_at(strings, r.u16()), "color": _str_at(strings, r.u16()),
			"alive": r.u8() != 0, "isBot": r.u8() != 0,
			"logs": r.u32(), "deliveries": r.u32(), "felled": r.u32(),
			"inTransit": r.u32(), "lost": r.u32(),
			"birthNext": null, "vid": null
		}
		if r.u8():
			tw["birthNext"] = r.f64()
		if r.u8():
			tw["vid"] = r.u32()
		towns.append(tw)
	out["towns"] = towns

	var buildings: Array = []
	var nb := r.varint()
	for b in range(nb):
		buildings.append({
			"id": _str_at(strings, r.u16()),
			"type": _str_at(strings, r.u16()),
			"variant": _str_at(strings, r.u16()),
			"rot": r.u16(),
			"x": r.u16() / 100.0,
			"y": r.u16() / 100.0,
			"owner": r.u8(), "town": r.u8(),
			"hp": r.f32(), "maxHp": r.f32(), "hpUntil": r.f32(),
			"flinch": roundf(r.f32() * 100.0) / 100.0,
			"rubble": r.u8() != 0
		})
	out["buildings"] = buildings

	var villagers: Array = []
	var nv := r.varint()
	for vi in range(nv):
		var v := {
			"id": r.u32(),
			"x": r.u16() / 100.0,
			"y": r.u16() / 100.0,
			"rot": r.u16()
		}
		var vf := r.u32()
		if vf & VF["OWNER"]:
			v["owner"] = r.u8()
		if vf & VF["TOWN"]:
			v["town"] = r.u8()
		if vf & VF["ANIM"]:
			v["anim"] = _str_at(strings, r.u16())
		if vf & VF["STATE"]:
			v["state"] = _str_at(strings, r.u16())
		if vf & VF["PHASE"]:
			v["phase"] = r.u16() / 1000.0
		if vf & VF["HP"]:
			v["hp"] = roundf(r.f32() * 10.0) / 10.0
		if vf & VF["HP_UNTIL"]:
			v["hpUntil"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["FLINCH"]:
			v["flinch"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["ATTACK_T"]:
			v["attackT"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["TRAINING"]:
			v["trainingId"] = _str_at(strings, r.u16())
			v["trainT"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["HOME"]:
			v["homeId"] = _str_at(strings, r.u16())
		if vf & VF["EMPLOYER"]:
			v["employerId"] = _str_at(strings, r.u16())
		if vf & VF["CAMP"]:
			v["campId"] = _str_at(strings, r.u16())
		if vf & VF["STATION"]:
			v["stationId"] = _str_at(strings, r.u16())
		if vf & VF["APPEAR"]:
			v["appearT"] = roundf(r.f32() * 100.0) / 100.0
			v["appearDur"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["VANISH"]:
			v["vanishT"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["EMERGE"]:
			v["emergeT"] = roundf(r.f32() * 100.0) / 100.0
		if vf & VF["ORDER"]:
			v["orderX"] = r.u16() / 100.0
			v["orderY"] = r.u16() / 100.0
		if vf & VF["DEATH"]:
			v["deathTimeMs"] = r.f64()
		if vf & VF["SAFE"]:
			v["safeExtrapolationTo"] = r.u32()
		var nm := r.varint()
		if nm > 0:
			var motion: Array = []
			for m in range(nm):
				motion.append({
					"t": r.u32(),
					"x": r.u16() / 100.0,
					"y": r.u16() / 100.0,
					"rot": r.u16()
				})
			v["motion"] = motion
		if vf & VF["FROZEN"]:
			v["frozen"] = 1
		if vf & VF["WARRIOR"]:
			v["warrior"] = 1
		if vf & VF["TRAINEE"]:
			v["trainee"] = 1
		if vf & VF["HIDDEN"]:
			v["hidden"] = 1
		if vf & VF["CARRYING"]:
			v["carrying"] = 1
		if vf & VF["DEAD"]:
			v["dead"] = 1
		if vf & VF["TELEPORT"]:
			v["teleport"] = 1
		villagers.append(v)
	out["villagers"] = villagers
	if r.err != "":
		return {"ok": false, "error": r.err}

	if flags & F_RESULTS:
		var results: Array = []
		var nr := r.varint()
		for qi in range(nr):
			var q := {
				"commandId": _str_at(strings, r.u16()),
				"clientSequence": r.u32(),
				"sessionId": _str_at(strings, r.u16()),
				"playerId": r.u32(),
				"owner": r.u8(),
				"status": _str_at(strings, r.u16()),
				"reasonCode": _str_at(strings, r.u16()),
				"reason": _str_at(strings, r.u16()),
				"ids": [],
				"appliedTick": null, "appliedRevision": null,
				"decidedTick": null, "decidedRevision": null,
				"epoch": 0
			}
			var nids := r.varint()
			for idn in range(nids):
				q["ids"].append(r.u32())
			var at := r.i32()
			if at >= 0:
				q["appliedTick"] = at
			var ar := r.i32()
			if ar >= 0:
				q["appliedRevision"] = ar
			var dt := r.i32()
			if dt >= 0:
				q["decidedTick"] = dt
			var dr := r.i32()
			if dr >= 0:
				q["decidedRevision"] = dr
			q["epoch"] = r.u32()
			if q["owner"] == 255:
				q["owner"] = null
			results.append(q)
		out["commandResults"] = results

	var hits: Array = []
	if version >= 2:
		var nh := r.varint()
		for hi in range(nh):
			var id := _str_at(strings, r.u16())
			var age := r.u16()
			if id != null:
				hits.append({"id": id, "age": age})
	out["treeHits"] = hits

	if r.err != "":
		return {"ok": false, "error": r.err}
	if r.pos != bytes.size():
		return {"ok": false, "error": "лишние байты: прочитано %d из %d" % [r.pos, bytes.size()]}
	return {"ok": true, "snapshot": out}


static func _str_at(strings: Array, idx: int) -> Variant:
	if idx == NULL_STR:
		return null
	if idx >= strings.size():
		return null
	return strings[idx]
