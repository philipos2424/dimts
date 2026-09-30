# Generate a synthetic two-person recording; no phone call or microphone needed.
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$audioDir = Join-Path $projectRoot '.data/audio-smoke'
New-Item -ItemType Directory -Force -Path $audioDir | Out-Null
$utterances = @{
    caller = 'Hello. This is Philip from Amax. Can we meet tomorrow at two?'
    owner = 'Yes. Tomorrow at two works. Please email me the pricing before then.'
    reply = 'I will email the pricing tonight. Thank you.'
}
foreach ($entry in $utterances.GetEnumerator()) {
    $voice = New-Object -ComObject SAPI.SpVoice
    $stream = New-Object -ComObject SAPI.SpFileStream
    $stream.Format.Type = 22
    $stream.Open((Join-Path $audioDir "$($entry.Key).wav"), 3)
    $voice.AudioOutputStream = $stream
    $voice.Speak($entry.Value) | Out-Null
    $stream.Close()
}
Write-Output 'Synthetic conversation generated in .data/audio-smoke'
