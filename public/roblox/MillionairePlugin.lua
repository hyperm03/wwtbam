--[[
	Millionaire Show Control - Studio plugin (install it once)
	1. In Studio, insert a Script anywhere (e.g. in ServerStorage), paste ALL of this text into it.
	2. Right-click the Script in the Explorer > "Save as Local Plugin...", then delete the Script.
	3. The "Plugins" tab now has the toolbar "Millionaire Show Control" with three buttons:
	   Link the set   - links every control button of the set to the web control room (the installer)
	   Restore        - puts back the original button scripts
	   Check          - tells what is missing: modules, HTTP requests, the link to the control room
	Messages appear in View > Output.
]]

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local SSS = game:GetService("ServerScriptService")
local SS = game:GetService("ServerStorage")

local HEADER = 'local __MB = require(game:GetService("ServerScriptService"):WaitForChild("MillionaireButtons")) -- Millionaire Show Control\n'
local PATTERN = "([%a_][%w_%.%[%]\"':%(%)]-)%.MouseClick%s*:%s*[cC]onnect%s*%("

local function say(text)
	print("[Millionaire] " .. text)
end

local function linkTheSet()
	if not SSS:FindFirstChild("MillionaireButtons") then
		warn("[Millionaire] Put the ModuleScript MillionaireButtons in ServerScriptService first")
		return
	end
	local recording = ChangeHistoryService:TryBeginRecording("Millionaire: link the set")
	local backup = SS:FindFirstChild("MillionaireBackup")
	if not backup then
		backup = Instance.new("Folder")
		backup.Name = "MillionaireBackup"
		backup.Parent = SS
	end
	local changed, already, skipped = 0, 0, 0
	for _, s in ipairs(game:GetDescendants()) do
		if s:IsA("Script") and not s:IsA("LocalScript") and not s:IsDescendantOf(backup) then
			local ok, src = pcall(function() return s.Source end)
			if ok and string.find(src, "MouseClick", 1, true) then
				if string.find(src, "__MB.connect(", 1, true) then
					already += 1
				else
					local new, n = string.gsub(src, PATTERN, "__MB.connect(%1, ")
					if n > 0 then
						local keep = Instance.new("StringValue")
						keep.Name = s.Name
						keep.Value = src
						keep:SetAttribute("Path", s:GetFullName())
						local target = Instance.new("ObjectValue")
						target.Name = "Target"
						target.Value = s
						target.Parent = keep
						keep.Parent = backup
						s.Source = HEADER .. new
						changed += 1
					else
						skipped += 1
					end
				end
			end
		end
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	say(("%d button scripts linked, %d were already linked, %d not changed. Save the place."):format(changed, already, skipped))
end

local function restore()
	local backup = SS:FindFirstChild("MillionaireBackup")
	if not backup then
		warn("[Millionaire] Nothing to restore: ServerStorage/MillionaireBackup is missing")
		return
	end
	local recording = ChangeHistoryService:TryBeginRecording("Millionaire: restore the set")
	local restored, missing = 0, 0
	for _, keep in ipairs(backup:GetChildren()) do
		local target = keep:FindFirstChild("Target")
		local s = target and target.Value
		if s and s:IsA("Script") then
			s.Source = keep.Value
			restored += 1
		else
			missing += 1
		end
	end
	if missing == 0 then
		backup:Destroy()
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	say(("%d scripts restored, %d not found."):format(restored, missing))
end

local function check()
	say("---------------- check ----------------")
	local buttons = SSS:FindFirstChild("MillionaireButtons")
	local link = SSS:FindFirstChild("MillionaireLink")
	say("MillionaireButtons in ServerScriptService: " .. (buttons and (buttons:IsA("ModuleScript") and "OK" or "WRONG TYPE (must be a ModuleScript)") or "MISSING"))
	say("MillionaireLink in ServerScriptService: " .. (link and (link:IsA("Script") and not link:IsA("LocalScript") and "OK" or "WRONG TYPE (must be a Script)") or "MISSING"))
	if link and link:IsA("Script") then
		say("MillionaireLink enabled: " .. (link.Enabled and "yes" or "NO - tick Enabled in its properties"))
	end
	local linked, raw = 0, 0
	for _, s in ipairs(game:GetDescendants()) do
		if s:IsA("Script") and not s:IsA("LocalScript") then
			local ok, src = pcall(function() return s.Source end)
			if ok then
				if string.find(src, "__MB.connect(", 1, true) then
					linked += 1
				elseif string.find(src, "MouseClick", 1, true) and string.find(src, "MouseClick%s*:%s*[cC]onnect") then
					raw += 1
				end
			end
		end
	end
	say(("Button scripts linked: %d, not linked yet: %d%s"):format(linked, raw, raw > 0 and " (press Link the set)" or ""))
	say("Allow HTTP Requests: " .. (HttpService.HttpEnabled and "ON" or "OFF - turn it on in Game Settings > Security"))
	if link then
		local src = link.Source
		local base = string.match(src, 'BaseUrl%s*=%s*"([^"]*)"')
		local show = string.match(src, 'ShowId%s*=%s*"([^"]*)"')
		local key = string.match(src, 'Key%s*=%s*"([^"]*)"')
		say("BaseUrl: " .. tostring(base) .. " | ShowId: " .. tostring(show) .. " | Key: " .. (key and #key > 10 and "set" or "MISSING"))
		if base and string.find(base, "{{", 1, true) then
			warn("[Millionaire] MillionaireLink was not downloaded from the control room: download it from the Roblox tab")
		elseif base and (string.find(base, "localhost", 1, true) or string.find(base, "127.0.0.1", 1, true) or string.find(base, "192.168.", 1, true)) then
			warn("[Millionaire] BaseUrl is a local address: Roblox servers cannot reach it, use the public https address of the platform")
		end
		if base and show and key then
			local url = string.gsub(base, "/+$", "") .. "/roblox-link/" .. HttpService:UrlEncode(show) .. "/poll?since=-1&job=studio-check"
			local ok, res = pcall(function()
				return HttpService:RequestAsync({ Url = url, Method = "GET", Headers = { ["X-Roblox-Key"] = key } })
			end)
			if not ok then
				warn("[Millionaire] Cannot reach the control room: " .. tostring(res))
			elseif res.StatusCode == 200 then
				say("Control room reachable and key accepted: the link works. Press Play (or publish) and the Roblox tab shows \"connected\".")
			elseif res.StatusCode == 403 then
				warn("[Millionaire] The control room answered 403: the link of this show is OFF in the Roblox tab, or the key / show id is wrong (download MillionaireLink again)")
			else
				warn(("[Millionaire] The control room answered HTTP %d"):format(res.StatusCode))
			end
		end
	end
	say("---------------------------------------")
end

local toolbar = plugin:CreateToolbar("Millionaire Show Control")
local linkButton = toolbar:CreateButton("Link the set", "Link every control button of the set to the web control room", "")
local restoreButton = toolbar:CreateButton("Restore", "Put back the original button scripts", "")
local checkButton = toolbar:CreateButton("Check", "Check the Roblox link and say what is missing", "")
for _, b in ipairs({ linkButton, restoreButton, checkButton }) do
	b.ClickableWhenViewportHidden = true
end
linkButton.Click:Connect(function() linkTheSet() linkButton:SetActive(false) end)
restoreButton.Click:Connect(function() restore() restoreButton:SetActive(false) end)
checkButton.Click:Connect(function() check() checkButton:SetActive(false) end)
