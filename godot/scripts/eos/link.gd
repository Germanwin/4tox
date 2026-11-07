class_name ToxEosLink
extends RefCounted

## Транспорт «дейтаграмма от пира к пиру» для отдельного EOS-режима.
##
## Это единственное место, которое знает, чем именно возят пакеты: настоящим
## EOS P2P (`ToxEosP2PLink`) или петлёй в одном процессе (`ToxEosLoopLink`,
## только для приёмки). Туннель и режим выше работают с этим интерфейсом и
## потому проверяются без Epic-продукта.
##
## Пакет — один вызов `send`, порядок и доставку держит транспорт: у EOS это
## `EOSGMultiplayerPeer` в режиме RELIABLE (проверено по исходникам аддона,
## см. EOS.md §2), у петли — очередь в памяти.

signal packet(from: int, data: PackedByteArray)
signal peer_up(peer: int)
signal peer_down(peer: int)
signal failed(text: String)

## Последняя причина отказа — чтобы экран показал её, а не «не поднялось».
var last_error := ""

## Есть ли вообще транспорт: установлен аддон EOS и известны ключи продукта.
func available() -> bool:
	return false

## Создать комнату (хозяин). false — причина в `failed`.
func start_host() -> bool:
	return false

## Войти в комнату по её id (гость).
func start_client(_room_id: String) -> bool:
	return false

## Id комнаты, который дают другу.
func room_id() -> String:
	return ""

## Id пиров, с которыми сейчас есть связь.
func peers() -> Array:
	return []

## Id хозяина с точки зрения гостя.
func host_peer() -> int:
	return 0

func send(_to: int, _data: PackedByteArray) -> bool:
	return false

func disconnect_peer(_peer: int) -> bool:
	return false

## Забрать входящее; зовётся из `_process` туннеля.
func poll() -> void:
	pass

func stop() -> void:
	pass

## Человеческое описание состояния для экрана лобби.
func error_text() -> String:
	return last_error


func describe() -> String:
	return "нет транспорта"
