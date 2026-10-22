--[[
	Millionaire Show Control - MillionaireButtons (ModuleScript, put it in ServerScriptService)

	The "button bus" of the set. Every control button script of the set registers its click function here (the
	installer changes "X.MouseClick:Connect(fn)" into "__MB.connect(X, fn)", nothing else), so a button can be pressed:
	  - by a real click in the game, exactly as before;
	  - by the web control room, through MillionaireLink: the very same function runs, so lights, graphics, sounds and
	    screens of the set behave exactly as with a click.
]]

local Bus = {}

local handlers = {}   -- [full name of the button part] = { function, ... }
local listeners = {}  -- called on every real click: function(path, player)

-- Name used for the presses of the web control room: the first name of ControlRoomPermissions (so the
-- permission checks of the buttons pass), unless MillionaireLink sets another one
Bus.operatorName = nil

local function pathOf(detector)
	local part = detector.Parent
	return part and part:GetFullName() or detector:GetFullName()
end

--- Replaces detector.MouseClick:Connect(fn): connects the real click and registers fn for the web control room.
function Bus.connect(detector, fn)
	local path = pathOf(detector)
	handlers[path] = handlers[path] or {}
	table.insert(handlers[path], fn)
	return detector.MouseClick:Connect(function(player, ...)
		for _, listener in ipairs(listeners) do
			task.spawn(listener, path, player)
		end
		fn(player, ...)
	end)
end

--- function(path, player) called when someone clicks a button in the game.
function Bus.onManualPress(listener)
	table.insert(listeners, listener)
end

--- Full names of every registered button, sorted.
function Bus.list()
	local list = {}
	for path in pairs(handlers) do
		table.insert(list, path)
	end
	table.sort(list)
	return list
end

--- The stand-in player of the web control room: the scripts only use its name (and Kick, which does nothing).
function Bus.operator()
	local name = Bus.operatorName
	if not name then
		local module = game:GetService("ServerScriptService"):FindFirstChild("ControlRoomPermissions")
		if module then
			local ok, list = pcall(require, module)
			if ok and type(list) == "table" and type(list[1]) == "string" then
				name = list[1]
			end
		end
	end
	name = name or "WebControlRoom"
	return {
		Name = name,
		name = name,
		DisplayName = name,
		UserId = 0,
		Kick = function() end,
		kick = function() end,
		IsA = function() return false end,
	}
end

--- Presses a button as the web control room. Returns false if no button has that name.
function Bus.press(path)
	local list = handlers[path]
	if not list then
		return false
	end
	local operator = Bus.operator()
	for _, fn in ipairs(list) do
		task.spawn(fn, operator)
	end
	return true
end

return Bus
