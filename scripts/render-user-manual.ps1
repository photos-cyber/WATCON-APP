# Use an isolated, hidden Word instance to render the requested DOCX for layout QA.
$ErrorActionPreference = 'Stop'
$auditRoot = Split-Path -Parent $PSScriptRoot
$auditDocPath = Join-Path $auditRoot 'docs\user-guide\WATCON_USER_GUIDE.docx'
$auditPdfPath = Join-Path $auditRoot 'docs\audit\evidence\word-manual-render.pdf'
$auditWord = $null
$auditDocument = $null
try {
    $auditWord = New-Object -ComObject Word.Application
    $auditWord.Visible = $false
    $auditWord.DisplayAlerts = 0
    $auditDocument = $auditWord.Documents.Open($auditDocPath, $false, $false)
    $auditDocument.Fields.Update() | Out-Null
    foreach ($auditContents in $auditDocument.TablesOfContents) { $auditContents.Update() }
    $auditDocument.Save()
    $auditDocument.ExportAsFixedFormat($auditPdfPath, 17)
    Write-Output 'Word manual rendered for visual QA.'
} finally {
    if ($null -ne $auditDocument) { $auditDocument.Close(0) }
    if ($null -ne $auditWord) { $auditWord.Quit() }
}
