--[[ Millionaire Show Control - UNINSTALL
     Studio: View > Command Bar, paste ALL of this text, press Enter.
     Restores the original text of every button script changed by the installer (from ServerStorage/MillionaireBackup).
     Then you can delete MillionaireButtons and MillionaireLink from ServerScriptService.
]]
local backup = game:GetService("ServerStorage"):FindFirstChild("MillionaireBackup")
if not backup then
	error("Nothing to restore: ServerStorage/MillionaireBackup is missing")
end
local restored, missing = 0, 0
for _, keep in ipairs(backup:GetChildren()) do
	local target = keep:FindFirstChild("Target")
	local s = target and target.Value
	if s and s:IsA("Script") then
		s.Source = keep.Value
		restored += 1
	else
		missing += 1
		warn("[Millionaire] script not found (deleted?): " .. tostring(keep:GetAttribute("Path") or keep.Name))
	end
end
print(("[Millionaire] %d scripts restored, %d not found."):format(restored, missing))
if missing == 0 then
	backup:Destroy()
end
