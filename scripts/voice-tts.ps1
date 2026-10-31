# Dev tool: synthesizes speech to a 16 kHz mono WAV with the Windows text-to-speech voices, so the voice
# engines can be tested without a microphone. Usage: voice-tts.ps1 -Text "..." -Out file.wav [-Culture pt-BR]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Culture = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Culture) {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -ieq $Culture } | Select-Object -First 1
    if (-not $voice) { throw "No installed voice for $Culture" }
    $synth.SelectVoice($voice.VoiceInfo.Name)
  }
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($Out, $format)
  $synth.Speak($Text)
} finally {
  $synth.Dispose()
}
Write-Output "wrote $Out"
