extends SceneTree

func _init() -> void:
	_run()

func _run() -> void:
	await process_frame
	var http := HTTPRequest.new()
	http.use_threads = true
	http.timeout = 8
	root.add_child(http)
	http.set_tls_options(TLSOptions.client(null, "374412.fornex.cloud"))
	var error := http.request("https://213.239.158.37/api/eos-coordinator/config", ["Host: 374412.fornex.cloud"])
	if error != OK:
		print("direct start error ", error)
		quit(1)
		return
	var result: Array = await http.request_completed
	print("direct request result=", result[0], " HTTP=", result[1])
	quit(0 if int(result[0]) == HTTPRequest.RESULT_SUCCESS and int(result[1]) == 200 else 1)
