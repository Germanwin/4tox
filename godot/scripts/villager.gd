class_name ToxVillager
extends RefCounted

## One inhabitant. The state machine lives in ToxSim, this is the data + the
## animation clock, mirroring mapgen2/js/villager.js fields.

var id: int = 0
var name: String = "Житель"
var owner: int = 0
var home_id: int = -1

var x: float = 0.0
var y: float = 0.0
var rot: float = 0.0
# Client-side snapshot target; the view lerps x/y toward it between snapshots.
var net_x: float = -1.0
var net_y: float = -1.0
var anim: String = "idle"
var phase: float = 0.0
var anim_t: float = 0.0

var state: String = "wander"
var path: Array[Vector2i] = []
var path_i: int = 0
var goal: Vector2i = Vector2i(-1, -1)
var anchor: Vector2 = Vector2.ZERO

var employer_id: int = -1
var tree: Variant = null
var carry: int = 0
var chop_t: float = 0.0
var drop_t: float = 0.0
var wait_t: float = 0.0
var work_retry: float = 0.0

var warrior: bool = false
var trainee: bool = false
var training_at_id: int = -1
var train_t: float = 0.0
var warcamp_id: int = -1
var garrison_id: int = -1
var camp_slot: Vector2i = Vector2i(-1, -1)

var hidden: bool = false
var vanish_t: float = 0.0
var emerge_t: float = 0.0
var enter_from: Vector2 = Vector2.ZERO
var enter_to: Vector2 = Vector2.ZERO
var enter_t: float = 0.0
var appear_t: float = 0.5

var hp: float = 15.0
var max_hp: float = 15.0
var dead: bool = false
var flinch: float = 0.0

var speed: float = 0.63
var rng: ToxRNG
var attack_t: float = 0.0
var windup_t: float = 0.0
var target: Variant = null
var hold_fire: bool = false
var order: Vector2i = Vector2i(-1, -1)
var order_active: bool = false
var stuck: float = 0.0
var think_t: float = 0.0
var selected: bool = false

func _init(p_seed: int = 1) -> void:
	rng = ToxRNG.new(p_seed)

func set_anim(next: String) -> void:
	if anim != next:
		anim = next
		anim_t = 0.0
		phase = 0.0

func tick_anim(dt: float) -> void:
	anim_t += dt
	var fps := ToxAtlasDB.character_fps(warrior, anim)
	var n := maxi(1, ToxAtlasDB.character_frames(warrior, anim))
	phase = fmod(anim_t * fps / float(n), 1.0)

func frame_index() -> int:
	var n := maxi(1, ToxAtlasDB.character_frames(warrior, anim))
	return mini(n - 1, int(floor(phase * n)))

func face_to(direction: Vector2) -> void:
	if direction.length_squared() < 0.0001:
		return
	rot = rad_to_deg(atan2(direction.y, direction.x))

func carrying() -> bool:
	return carry > 0

func visible() -> bool:
	return not hidden and vanish_t <= 0.0
