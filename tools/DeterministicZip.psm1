Set-StrictMode -Version 2.0

function New-DeterministicZip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDirectory,
        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression
    $sourceRoot = [System.IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\', '/')
    [string[]]$relativeFiles = [System.IO.Directory]::EnumerateFiles(
        $sourceRoot,
        '*',
        [System.IO.SearchOption]::AllDirectories
    ) | ForEach-Object {
        $_.Substring($sourceRoot.Length).TrimStart('\', '/').Replace('\', '/')
    }
    [System.Array]::Sort($relativeFiles, [System.StringComparer]::Ordinal)
    $fixedTimestamp = [System.DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
    $archiveStream = [System.IO.File]::Open(
        $DestinationPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $archive = $null
    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $archiveStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        foreach ($relativePath in $relativeFiles) {
            $entry = $archive.CreateEntry(
                $relativePath,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
            $entry.LastWriteTime = $fixedTimestamp
            $inputStream = [System.IO.File]::OpenRead((Join-Path $sourceRoot $relativePath))
            $outputStream = $entry.Open()
            try {
                $inputStream.CopyTo($outputStream)
            }
            finally {
                $outputStream.Dispose()
                $inputStream.Dispose()
            }
        }
    }
    finally {
        if ($archive) {
            $archive.Dispose()
        } else {
            $archiveStream.Dispose()
        }
    }
}

Export-ModuleMember -Function New-DeterministicZip
