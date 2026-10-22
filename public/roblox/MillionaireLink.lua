--[[
	Millionaire Show Control - MillionaireLink (Script, put it in ServerScriptService)

	Links this Roblox set to a show of the web control room. Every ~0.35 s it asks the platform for the commands
	of the show and runs them:
	  press     - presses a button of the set (through MillionaireButtons), e.g. ShowQuestionAnswers, AnswerB, ShowCorrect
	  question  - loads the control room's question into the set (QuestionModule + Values) before it is shown
	  fff       - loads the Fastest Finger question (FFFQuestionModule + Values)
	  value     - sets a value object, e.g. the contestant's name
	It also tells the platform which buttons the set has, and every button pressed by hand in the game.

	Requirements: Game Settings > Security > "Allow HTTP Requests" ON; MillionaireButtons in ServerScriptService;
	the button scripts linked once with the installer (Install.lua, in Studio's command bar).
]]

local CONFIG = {
	BaseUrl = "{{BASE_URL}}",   -- address of the web platform
	ShowId = "{{SHOW_ID}}",     -- the show of the control room
	Key = "{{KEY}}",            -- secret key of the show's Roblox link (keep it private)
	PollInterval = 0.35,         -- seconds between two requests (Roblox allows about 500 requests a minute)
}

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ServerScriptService = game:GetService("ServerScriptService")
local Bus = require(ServerScriptService:WaitForChild("MillionaireButtons"))

local base = string.gsub(CONFIG.BaseUrl, "/+$", "") .. "/roblox-link/" .. HttpService:UrlEncode(CONFIG.ShowId)
local jobId = (game.JobId ~= "" and game.JobId) or "studio"

local function request(method, path, body)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = base .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json", ["X-Roblox-Key"] = CONFIG.Key },
			Body = body and HttpService:JSONEncode(body) or nil,
		})
	end)
	if not ok then
		return nil, tostring(res)
	end
	if not res.Success then
		return nil, ("HTTP %d %s"):format(res.StatusCode, tostring(res.Body))
	end
	local okJson, data = pcall(function()
		return HttpService:JSONDecode(res.Body)
	end)
	if okJson then
		return data
	end
	return nil, "not JSON"
end

-- ------------------------------------------------------------------ the set
local values = workspace:WaitForChild("QandASystem"):WaitForChild("QuestionControl"):WaitForChild("Values")
local QuestionModule = require(ServerScriptService:WaitForChild("QuestionModule"))
local FFFModule = require(ServerScriptService:WaitForChild("FFFQuestionModule"))

--- An object by its full name, e.g. "Workspace.QandASystem.QuestionControl.Values.ContestantName".
local function findByPath(path)
	local node = game
	for part in string.gmatch(path, "[^%.]+") do
		node = node:FindFirstChild(part)
		if not node then
			return nil
		end
	end
	return node
end

--- The control room's question, into the set: the set's own scripts then show it exactly as one of theirs.
local function loadQuestion(c)
	local set = values.SetNumber.Value
	QuestionModule.Questions[set] = QuestionModule.Questions[set] or {}
	local a = c.answers or {}
	QuestionModule.Questions[set][c.level] = { c.text, a[1], a[2], a[3], a[4], c.correct, c.fifty }
	values.Question.Value = c.text
	values.Question.AnswerA.Value = a[1] or ""
	values.Question.AnswerB.Value = a[2] or ""
	values.Question.AnswerC.Value = a[3] or ""
	values.Question.AnswerD.Value = a[4] or ""
	values.Question.Correct.Value = c.correct or "A"
	values.Question.FiftyFifty.Value = c.fifty or ""
	if values.QuestionNumber.Value ~= c.level then
		values.QuestionNumber.Value = c.level -- the set's own script reloads the same question from QuestionModule
	end
end

local function loadFFF(c)
	local n = values.FFFQuestionNumber.Value
	if n < 1 then
		n = 1
	end
	FFFModule.FFFQuestions[1] = FFFModule.FFFQuestions[1] or {}
	local a = c.answers or {}
	FFFModule.FFFQuestions[1][n] = { c.text, a[1], a[2], a[3], a[4], c.order }
	local q = values.FFFQuestion
	q.Value = c.text
	q.FFFAnswerA.Value = a[1] or ""
	q.FFFAnswerB.Value = a[2] or ""
	q.FFFAnswerC.Value = a[3] or ""
	q.FFFAnswerD.Value = a[4] or ""
	q.FFFCorrectOrder.Value = c.order or ""
end

--- "lifeline:3": the LifeControl of the lifeline slot holding lifeline type 3, whatever slot it was put in.
local function lifelineButton(kind)
	local folder = workspace.QandASystem.QuestionControl:FindFirstChild("Lifelines")
	if not folder then
		return nil
	end
	for _, slot in ipairs(folder:GetChildren()) do
		local number = slot:FindFirstChild("LifelineNumber")
		local control = slot:FindFirstChild("LifeControl")
		if number and control and number.Value == kind then
			return control:GetFullName()
		end
	end
	return nil
end

local function run(c)
	local ok, err = pcall(function()
		if c.type == "press" then
			local path = c.path
			local kind = tonumber(string.match(path, "^lifeline:(%d+)$"))
			if kind then
				path = lifelineButton(kind)
				if not path then
					warn("[Millionaire] no lifeline slot holds lifeline type " .. kind .. " (set it with LifeIncr / LifeDecr)")
					return
				end
			end
			if not Bus.press(path) then
				warn("[Millionaire] no button called " .. tostring(path))
			end
		elseif c.type == "question" then
			loadQuestion(c)
		elseif c.type == "fff" then
			loadFFF(c)
		elseif c.type == "value" then
			local obj = findByPath(c.path)
			if obj and obj:IsA("ValueBase") then
				obj.Value = c.value
			end
		end
	end)
	if not ok then
		warn("[Millionaire] command " .. tostring(c.type) .. " failed: " .. tostring(err))
	end
end

-- ------------------------------------------------------------------ buttons pressed by hand in the game -> show log
Bus.onManualPress(function(path, player)
	request("POST", "/report", { type = "pressed", path = path, player = player and player.Name or nil })
end)

-- ------------------------------------------------------------------ connection
local function hello()
	local data, err = request("POST", "/hello", {
		placeId = game.PlaceId, jobId = jobId, players = #Players:GetPlayers(), buttons = Bus.list(),
	})
	if data then
		print(("[Millionaire] linked to the show \"%s\" (%d buttons)"):format(tostring(data.show), #Bus.list()))
	else
		warn("[Millionaire] cannot reach the control room: " .. tostring(err))
	end
end

task.spawn(function()
	task.wait(3) -- let every button script register first
	hello()
	local lastId = -1
	local lastHello = os.clock()
	while true do
		local data = request("GET", ("/poll?since=%d&job=%s&place=%d&players=%d"):format(
			lastId, HttpService:UrlEncode(jobId), game.PlaceId, #Players:GetPlayers()))
		if data then
			if lastId < 0 then
				lastId = tonumber(data.last) or 0 -- a new server starts from now, without replaying old commands
			else
				local pressed = false
				for _, c in ipairs(data.commands or {}) do
					if c.id > lastId then
						lastId = c.id
						-- presses one after the other (e.g. the steps of a lifeline): each starts after the previous
						if c.type == "press" and pressed then
							task.wait(0.2)
						end
						run(c)
						pressed = pressed or c.type == "press"
					end
				end
			end
		end
		if os.clock() - lastHello > 60 then
			lastHello = os.clock()
			hello()
		end
		task.wait(CONFIG.PollInterval)
	end
end)
