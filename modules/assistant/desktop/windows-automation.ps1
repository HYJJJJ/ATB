$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  function ShortText($value, $limit=100) { $text = [string]$value; if ($text.Length -gt $limit) { return $text.Substring(0,$limit) }; return $text }
  function AllowedProcess($process) { return $process.ProcessName -notmatch '^(powershell|pwsh|cmd|WindowsTerminal|conhost|regedit|mmc|taskmgr|rundll32|electron|ATB|Codex)$' }
  function Identity($process, $handle, $title) { return @{handle=$handle.ToString();pid=$process.Id;start=$process.StartTime.ToUniversalTime().Ticks.ToString();title=(ShortText $title 160);process=$process.ProcessName} }
  if ($request.action -eq 'windows') {
    $windows = New-Object 'System.Collections.Generic.List[object]'
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $roots) {
      if ($windows.Count -ge 40) { break }
      try {
        $current=$item.Current
        if ($current.IsOffscreen -or !$current.NativeWindowHandle -or !$current.Name) { continue }
        $process=Get-Process -Id $current.ProcessId
        if (!(AllowedProcess $process)) { continue }
        if ($request.query -and $current.Name.IndexOf([string]$request.query,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and $process.ProcessName.IndexOf([string]$request.query,[StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $windows.Add((Identity $process $current.NativeWindowHandle $current.Name))
      } catch { continue }
    }
    @{ok=$true;windows=@($windows.ToArray())} | ConvertTo-Json -Depth 8 -Compress
    exit
  }
  $ownerProcess = Get-Process -Id ([int]$request.window.pid)
  if (!(AllowedProcess $ownerProcess) -or $ownerProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.window.start) { throw 'window-changed' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$request.window.handle))
  if (!$root -or $root.Current.ProcessId -ne $ownerProcess.Id) { throw 'window-changed' }
  $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
  $queue.Enqueue($root)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = New-Object 'System.Collections.Generic.List[object]'
  $inputs = New-Object 'System.Collections.Generic.List[object]'
  $inputsComplete = $true
  $inputLength = 0
  $target = $null
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 700) {
    $element = $queue.Dequeue(); $visited++
    try {
      $current = $element.Current
      if ($current.ProcessId -ne $ownerProcess.Id -or $current.IsPassword -or $current.IsOffscreen) { continue }
      $runtime = $element.GetRuntimeId() -join '.'
      if ($request.action -eq 'interact' -and $runtime -eq $request.runtimeId) { $target=$element }
      $pattern = $null; $actions = New-Object 'System.Collections.Generic.List[string]'
      if ($current.IsEnabled -and $current.IsKeyboardFocusable) { $actions.Add('focus') }
      $value = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
        if (!$pattern.Current.IsReadOnly -and $current.IsEnabled) { $actions.Add('set_value') }
        $fullValue = [string]$pattern.Current.Value
        $value = ShortText $fullValue 160
        if (!$pattern.Current.IsReadOnly -and $current.IsEnabled) {
          $inputLength += $fullValue.Length
          if ($fullValue.Length -gt 2000 -or $inputLength -gt 6000) { $inputsComplete = $false }
          else { $inputs.Add(@{runtimeId=$runtime;name=(ShortText $current.Name);value=$fullValue}) }
        }
      }
      if ($current.IsEnabled -and $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $actions.Add('invoke') }
      if ($current.IsEnabled -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $actions.Add('select') }
      if ($request.action -eq 'snapshot' -and $nodes.Count -lt 60 -and ($current.Name -or $actions.Count)) {
        $node = @{runtimeId=$runtime;name=(ShortText $current.Name);type=$current.ControlType.ProgrammaticName.Replace('ControlType.','');actions=@($actions.ToArray())}
        if ($null -ne $value) { $node.value=$value }; $nodes.Add($node)
      }
      $child=$walker.GetFirstChild($element)
      while ($child -and $queue.Count -lt 700) { $queue.Enqueue($child); $child=$walker.GetNextSibling($child) }
      if ($child) { $inputsComplete=$false }
    } catch { $inputsComplete=$false; continue }
  }
  if ($queue.Count -gt 0) { $inputsComplete=$false }
  if ($request.action -eq 'snapshot') { @{ok=$true;nodes=@($nodes.ToArray());inputs=@($inputs.ToArray());inputsComplete=$inputsComplete;truncated=($visited -ge 700 -or $nodes.Count -ge 60)} | ConvertTo-Json -Depth 8 -Compress; exit }
  if (!$target -or !$target.Current.IsEnabled -or $target.Current.IsPassword -or $target.Current.Name -ne $request.expectedName -or $target.Current.ControlType.ProgrammaticName.Replace('ControlType.','') -ne $request.expectedType) { throw 'control-changed' }
  if ($request.operation -ne 'focus') {
    if (!$inputsComplete -or $null -eq $request.expectedInputs -or @($request.expectedInputs).Count -ne $inputs.Count) { throw 'input-changed' }
    foreach ($expected in @($request.expectedInputs)) {
      $matching = @($inputs | Where-Object { $_.runtimeId -eq $expected.runtimeId })
      if ($matching.Count -ne 1 -or $matching[0].name -cne $expected.name -or $matching[0].value -cne $expected.value) { throw 'input-changed' }
    }
  }
  $pattern=$null
  switch ($request.operation) {
    'focus' { $target.SetFocus() }
    'set_value' {
      if (!$target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -or $pattern.Current.IsReadOnly -or $request.text.Length -gt 2000 -or $request.text -match '[\x00-\x1f]') { throw 'unsupported-control' }
      $pattern.SetValue([string]$request.text)
    }
    'invoke' { if (!$target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { throw 'unsupported-control' }; $pattern.Invoke() }
    'select' { if (!$target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { throw 'unsupported-control' }; $pattern.Select() }
    default { throw 'unsupported-control' }
  }
  @{ok=$true;data=@{message='控件操作已完成，请重新查看窗口核实结果。'}} | ConvertTo-Json -Compress
} catch {
  @{ok=$false;error='desktop-control-unavailable';message='窗口或控件已变化，或应用未开放此控件；未确认操作成功，请重新查看。'} | ConvertTo-Json -Compress
}
