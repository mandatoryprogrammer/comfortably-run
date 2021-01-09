const CDP = require('chrome-remote-interface');
const { Command } = require('commander');
const util = require('util');
const fs = require('fs');

const wait = ms => new Promise(res => setTimeout(res, ms));

const program_banner = `
                       __           _        _     _       
                      / _|         | |      | |   | |      
   ___ ___  _ __ ___ | |_ ___  _ __| |_ __ _| |__ | |_   _ 
  / __/ _ \\| '_ \` _ \\|  _/ _ \\| '__| __/ _\` | '_ \\| | | | |
 | (_| (_) | | | | | | || (_) | |  | || (_| | |_) | | |_| |
  \\___\\___/|_| |_| |_|_| \\___/|_|   \\__\\__,_|_.__/|_|\\__, |
 | '__| | | | '_ \\                                    __/ |
 | |  | |_| | | | |                                  |___/ 
 |_|   \\__,_|_| |_|   by mandatory (@IAmMandatory)          
`;

(async () => {
	const program = new Command();

	program
	.version('0.0.1')
	.description('comfortably-run is a CLI utility which can be used to inject JavaScript into arbitrary Chrome origins via the Chrome DevTools Protocol.')
	.option('-h, --host <value>', 'Host that Chrome/Chromium is running remote debugging on (default \'localhost\').')
	.option('-p, --port <number>', 'Port which remote debugging is hosted on (default 9222).', 9222)
	.option('-m, --method <value>', 'The method of injection. Works either by evaluating in an existing page ("existing") or by creating a new page in the background for the origin ("create") if one does not exist. Default is "existing" which will fail if no pages exist with the origin specified. Note that this will *not* affect the original script as the injected script is run in an isolated world.', 'existing')
	.option('-c, --cleanup', 'Only available if using the "create" method. Closes out the created page after injecting the script.', false)
	.requiredOption('-s, --script <value>', 'Either a path to a JavaScript file or inline JavaScript to execute in the specified origin.')
	.requiredOption('-o, --origin <value>', 'The origin to inject the JavaScript into, such as https://example.com or chrome-extension://cjpalhdlnbpafiamejdnhcphjbkeiagm')
	.option('-q, --quiet', 'Don\'t print any output during execution.', false)

	program.parse(process.argv);

	// Don't allow specifying "cleanup" and method "existing"
	if(program.cleanup && program.method === 'existing') {
		console.error(`Error, you cannot specify both an injection method of "existing" and require cleanup after injection.`);
		console.error(`If this ran it would close out something the browser session is currently using!`);
		process.exit(-1);
	}

	// Ensure user specified either "existing" or "create" for the injection method
	if(!["existing", "create"].includes(program.method)) {
		console.error(`Invalid method specified, you must specify either "existing" or "create"!`);
		process.exit(-1);
	}

	// Resolve the specified script
	const script_to_inject = await resolve_script(program.script);

	// Only print the banner if the user didn't specify quiet mode.
	if(!program.quiet) {
		console.log(program_banner);
	}

	const formatted_target_origin = (/^[a-p]{32}$/g.test(program.origin) ? `chrome-extension://${program.origin}` : program.origin);
	const target_origin = is_valid_origin(formatted_target_origin);

	if(!target_origin) {
		console.error(`Error, invalid origin specified: ${program.origin.trim()}`);
		console.error(`Please specify a valid origin, e.g: https://example.com, chrome-extension://cjpalhdlnbpafiamejdnhcphjbkeiagm`);
		process.exit(-1);
	}

	// Host settings for connecting to Chrome/Chromium
	const host_settings = {
		host: program.host,
		port: program.port
	};

	const cdp_client = await CDP({
		host: host_settings.host,
		port: host_settings.port
	});

	let target_origin_metadata = await get_target_with_matching_origin(
		cdp_client,
		target_origin
	);

	// Track if we had to create a window or not.
	let is_created_window = false;

	if(!target_origin_metadata && program.method === 'existing') {
		console.error(`No running pages were found with the origin you specified: ${target_origin}`);
		console.error(`If you'd like to create a new page with the origin specified use the "--method create" flag.`)
		process.exit(-1);
	}

	if(!target_origin_metadata) {
		target_origin_metadata = await create_new_target_with_origin(
			cdp_client,
			host_settings,
			target_origin
		);
		is_created_window = true;
	}

	console.log(`Target we're going after: `);
	console.log(target_origin_metadata);

	const target_id = target_origin_metadata.targetId;

	console.log(`Target ID is ${target_id}`);

	const injection_result = await inject_script_into_target(
		target_id,
		host_settings,
		script_to_inject
	);

	console.log(`*** Result of your injected script ***`);
	console.log(`Return type: ${injection_result.type}`);
	console.log(`Returned data:`);
	console.log(injection_result.value)

	// If we created a window for this and the user
	// asked for us to close it out after the script
	// has finished running, we close the window.
	if(is_created_window && program.cleanup) {
		const new_window_client = await CDP({
			target: target_id,
			host: host_settings.host,
			port: host_settings.port
		});

		const {Page} = new_window_client;

		const close_result = await Page.close();
	}

	process.exit(0);
})();

async function create_new_target_with_origin(cdp_client, host_settings, input_origin) {
	const { Target } = cdp_client;

	const created_target_data = await Target.createTarget({
		url: 'about:blank',
		newWindow: true,
		background: true
	});
	const created_target_id = created_target_data.targetId;

	// Pull metadata for what we just created
	const targets_metadata_array = await Target.getTargets();
	let new_target_metadata = false;

	targets_metadata_array.targetInfos.map(target_metadata => {
		const current_target_id = target_metadata.targetId;
		if(current_target_id == created_target_id) {
			new_target_metadata = target_metadata;
		}
	});

	// Now we need to minimize the window to make it stealthy
	// We'll also make the window smaller.
	const new_window_client = await CDP({
		target: created_target_id,
		host: host_settings.host,
		port: host_settings.port
	});

	const {Browser, Page, Fetch} = new_window_client;

	request_paused_event_promise = Fetch.requestPaused();

	// Enable request interception so we can intercept the
	// request to 
	const fetch_enabling = await Fetch.enable({
		patterns: [
			{
				urlPattern: `${input_origin}/`,
				requestStage: 'Request'
			}
		]
	});

	// Navigate to the origin the user specified...
	const page_navigate_promise = Page.navigate({
		url: input_origin
	});

	// Now wait until the promise resolves (should be basically immediate)
	const request_paused_event = await request_paused_event_promise;

	// Now we rewrite the response to be an immediate empty 200 OK
	// That way we load nothing from the actual origin and it will always
	// load as expected.
	const fulfill_result = await Fetch.fulfillRequest({
		requestId: request_paused_event.requestId,
		responseCode: 200,
		responseHeaders: [
			{
				name: 'Content-Type',
				value: 'text/plain'
			},
		],
		body: ''
	});

	// No need for any further interception
	await Fetch.disable();

	const new_window_metadata = await Browser.getWindowForTarget();
	const new_window_id = new_window_metadata.windowId;

	// Setting top and left to these large numbers appears to 
	// make it so the window will close when you click on it in
	// the bottom bar. This is actually nice behavior, so we
	// just roll with it.
	const resize_result = await Browser.setWindowBounds({
		windowId: new_window_id,
		bounds: {
			width: 1,
			height: 1
		}
	});

	const minimize_result = await Browser.setWindowBounds({
		windowId: new_window_id,
		bounds: {
			windowState: 'minimized',
		}
	});

	return new_target_metadata;
}

async function get_target_with_matching_origin(cdp_client, target_origin) {
	const { Target } = cdp_client;
	const available_targets = await Target.getTargets();
	const matching_targets = available_targets.targetInfos.filter(target_metadata => {
		return target_metadata.url.startsWith(target_origin);
	});
	if(matching_targets.length > 0) {
		return matching_targets[0];
	}

	return null;
}

function is_valid_origin(input_origin) {
	const valid_protocol_handlers = [
		'https:',
		'http:',
		'file:',
		'chrome-extension:',
		'chrome:'
	];

	let url_object = null;

	try {
		url_object = new URL(input_origin);
	} catch (e) {
		return false;
	}

	console.log(url_object);

	let has_valid_protocol_handler = false;

	valid_protocol_handlers.map(protocol_handler => {
		if(url_object.protocol.startsWith(protocol_handler)) {
			has_valid_protocol_handler = true;
		}
	});

	if(!has_valid_protocol_handler) {
		return false;
	}

	if(!url_object.origin) {
		return false;
	}

	if(url_object.origin === 'null') {
		return input_origin;
	}

	return url_object.origin;
}

async function resolve_script(filename_or_script) {
	// Attempt to resolve the supplied string as a filesystem path
	// If that fails (because it's actually an inline script) then just return
	// the entire specified string directly.
	const potential_file_contents = await attempt_file_script_resolve(filename_or_script);
	return (potential_file_contents === false ? filename_or_script : potential_file_contents);
}

async function attempt_file_script_resolve(filename_or_script) {
	const readFileAsync = util.promisify(fs.readFile);

	return readFileAsync(
		filename_or_script,
		{
			encoding: 'utf8',
			flag: 'r'
		}
	).then((file_contents => {
		return file_contents;
	}), (error) => {
		return false;
	});
}

async function inject_script_into_target(target_id, host_settings, script_to_inject) {
	const extension_target_client = await CDP({
		target: target_id,
		host: host_settings.host,
		port: host_settings.port
	});

	const {Target, Page, Runtime} = extension_target_client;

	const frame_tree = await Page.getFrameTree({});

	console.log(`Page tree:`);
	console.log(frame_tree);

	const isolated_world_data = await Page.createIsolatedWorld({
		frameId: frame_tree.frameTree.frame.id,
	});

	console.log(`Isolated world: `);
	console.log(isolated_world_data);

	const execution_context_id = isolated_world_data.executionContextId;

	const evaluate_results = await Runtime.evaluate({
		contextId: execution_context_id,
		expression: script_to_inject,
		awaitPromise: true,
	});

	return evaluate_results.result;
}