<#
.SYNOPSIS
  External HWND + pixel probe for the Windows calibration overlay (R29 evidence).

.DESCRIPTION
  Runs on the interactive desktop of a Windows machine (including the GitHub
  runner) beside a LumaSync process that has already opened its overlay. Dumps
  the overlay's window tree with ex-styles, hit-tests two points over it, and
  diffs the overlay rect against a baseline screenshot taken before the overlay
  opened.

  Reports; it does not judge. A "bad" verdict still exits 0 - the caller decides.
  See docs/architecture/build-and-release.md.

.NOTES
  PowerShell 5.1 / .NET Framework compatible: no C# 6+ syntax in the Add-Type
  block, no PowerShell 7-only cmdlets.
#>

[CmdletBinding()]
param(
    # Which LumaSync process to probe. -ProcessId wins; -ProcessName is the fallback.
    [int]$ProcessId = 0,
    [string]$ProcessName = "lumasync",

    # Overlay rect in PHYSICAL pixels, as logged by `[smoke-overlay] opened`.
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 0,
    [int]$Height = 0,

    # Baseline screenshot taken before the overlay opened, plus where its
    # top-left sits on the virtual desktop (so the overlay rect can be cropped
    # out of it).
    [string]$Baseline = "",
    [int]$BaselineX = 0,
    [int]$BaselineY = 0,

    [string]$Mode = "unknown",
    [string]$Out = ".",

    # Fraction of width/height treated as the "outer band" where the overlay
    # draws its LED capsules.
    [double]$BandFraction = 0.08,
    # Per-channel absolute delta above which a pixel counts as changed.
    [int]$PixelThreshold = 24,

    # Capture the primary display into <Out>\baseline.png and stop.
    [switch]$BaselineOnly
)

$ErrorActionPreference = "Stop"

$probeSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct LsPoint {
    public int X;
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
public struct LsRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public class LsWindowInfo {
    public string Hwnd;
    public string ClassName;
    public string Title;
    public bool Visible;
    public uint Pid;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public int Width;
    public int Height;
    public string ExStyle;
    public bool Layered;
    public bool Transparent;
    public bool NoActivate;
    public bool HasLayeredAttrs;
    public int LayeredAlpha;
    public string LayeredFlags;
    public string Parent;
    public int Depth;
}

public static class LsProbe {
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_LAYERED = 0x00080000L;
    public const long WS_EX_TRANSPARENT = 0x00000020L;
    public const long WS_EX_NOACTIVATE = 0x08000000L;
    public const uint GA_ROOT = 2;
    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    // 64-bit only export; the 32-bit fallback below is never taken on a runner.
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(LsPoint point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out LsRect lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint pcrKey, out byte pbAlpha, out uint pdwFlags);

    // Static so the marshalled function pointers stay rooted for the life of
    // the process; a collected delegate is a hard crash inside user32.
    private static readonly EnumWindowsProc TopLevelCallback = new EnumWindowsProc(CollectTopLevel);
    private static readonly EnumWindowsProc ChildCallback = new EnumWindowsProc(CollectChild);

    private static List<IntPtr> _collected = new List<IntPtr>();
    private static uint _filterPid;

    private static bool CollectTopLevel(IntPtr hWnd, IntPtr lParam) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == _filterPid) {
            _collected.Add(hWnd);
        }
        return true;
    }

    private static bool CollectChild(IntPtr hWnd, IntPtr lParam) {
        _collected.Add(hWnd);
        return true;
    }

    public static IntPtr[] TopLevelHandles(uint pid) {
        _collected = new List<IntPtr>();
        _filterPid = pid;
        EnumWindows(TopLevelCallback, IntPtr.Zero);
        return _collected.ToArray();
    }

    // EnumChildWindows already walks grandchildren, so this is the whole subtree.
    public static IntPtr[] DescendantHandles(IntPtr parent) {
        _collected = new List<IntPtr>();
        EnumChildWindows(parent, ChildCallback, IntPtr.Zero);
        return _collected.ToArray();
    }

    public static long ExStyle(IntPtr hWnd) {
        if (IntPtr.Size == 8) {
            return GetWindowLongPtrW(hWnd, GWL_EXSTYLE).ToInt64();
        }
        return (long)(uint)GetWindowLongW(hWnd, GWL_EXSTYLE);
    }

    public static string Hex(IntPtr handle) {
        return "0x" + handle.ToInt64().ToString("X");
    }

    private static int DepthFrom(IntPtr hWnd, IntPtr root) {
        int depth = 0;
        IntPtr current = hWnd;
        while (current != IntPtr.Zero && current != root && depth < 64) {
            current = GetParent(current);
            depth++;
        }
        return depth;
    }

    public static LsWindowInfo Describe(IntPtr hWnd, IntPtr root) {
        LsWindowInfo info = new LsWindowInfo();
        info.Hwnd = Hex(hWnd);

        StringBuilder classBuffer = new StringBuilder(256);
        GetClassNameW(hWnd, classBuffer, classBuffer.Capacity);
        info.ClassName = classBuffer.ToString();

        StringBuilder titleBuffer = new StringBuilder(512);
        GetWindowTextW(hWnd, titleBuffer, titleBuffer.Capacity);
        info.Title = titleBuffer.ToString();

        info.Visible = IsWindowVisible(hWnd);

        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        info.Pid = pid;

        LsRect rect;
        if (GetWindowRect(hWnd, out rect)) {
            info.Left = rect.Left;
            info.Top = rect.Top;
            info.Right = rect.Right;
            info.Bottom = rect.Bottom;
            info.Width = rect.Right - rect.Left;
            info.Height = rect.Bottom - rect.Top;
        }

        long ex = ExStyle(hWnd);
        info.ExStyle = "0x" + ex.ToString("X8");
        info.Layered = (ex & WS_EX_LAYERED) != 0;
        info.Transparent = (ex & WS_EX_TRANSPARENT) != 0;
        info.NoActivate = (ex & WS_EX_NOACTIVATE) != 0;

        uint colorKey;
        byte alpha;
        uint flags;
        if (GetLayeredWindowAttributes(hWnd, out colorKey, out alpha, out flags)) {
            info.HasLayeredAttrs = true;
            info.LayeredAlpha = (int)alpha;
            info.LayeredFlags = "0x" + flags.ToString("X");
        } else {
            info.HasLayeredAttrs = false;
            info.LayeredAlpha = -1;
            info.LayeredFlags = "";
        }

        info.Parent = Hex(GetParent(hWnd));
        info.Depth = DepthFrom(hWnd, root);
        return info;
    }

    public static IntPtr HitTest(int x, int y) {
        LsPoint point;
        point.X = x;
        point.Y = y;
        return WindowFromPoint(point);
    }

    public static IntPtr RootOf(IntPtr hWnd) {
        return GetAncestor(hWnd, GA_ROOT);
    }

    public static int[] PrimaryScreenSize() {
        return new int[] { GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN) };
    }

    public static void Capture(int x, int y, int width, int height, string path) {
        Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        Graphics graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        graphics.Dispose();
        bitmap.Save(path, ImageFormat.Png);
        bitmap.Dispose();
    }

    // Compares the whole of `afterPath` against the region of `basePath` that
    // starts at (offsetX, offsetY). Returns
    // { bandTotal, bandChanged, innerTotal, innerChanged, comparedW, comparedH }.
    public static long[] Compare(string basePath, string afterPath, int offsetX, int offsetY, double bandFraction, int threshold) {
        Bitmap baseImage = new Bitmap(basePath);
        Bitmap afterImage = new Bitmap(afterPath);

        int width = Math.Min(afterImage.Width, baseImage.Width - offsetX);
        int height = Math.Min(afterImage.Height, baseImage.Height - offsetY);

        long bandTotal = 0;
        long bandChanged = 0;
        long innerTotal = 0;
        long innerChanged = 0;

        if (width > 0 && height > 0 && offsetX >= 0 && offsetY >= 0) {
            BitmapData baseData = baseImage.LockBits(
                new Rectangle(0, 0, baseImage.Width, baseImage.Height),
                ImageLockMode.ReadOnly,
                PixelFormat.Format32bppArgb);
            BitmapData afterData = afterImage.LockBits(
                new Rectangle(0, 0, afterImage.Width, afterImage.Height),
                ImageLockMode.ReadOnly,
                PixelFormat.Format32bppArgb);

            byte[] baseRow = new byte[baseData.Stride];
            byte[] afterRow = new byte[afterData.Stride];

            int bandX = (int)Math.Round(width * bandFraction);
            int bandY = (int)Math.Round(height * bandFraction);
            if (bandX < 1) { bandX = 1; }
            if (bandY < 1) { bandY = 1; }

            for (int row = 0; row < height; row++) {
                Marshal.Copy(new IntPtr(baseData.Scan0.ToInt64() + (long)(row + offsetY) * baseData.Stride), baseRow, 0, baseData.Stride);
                Marshal.Copy(new IntPtr(afterData.Scan0.ToInt64() + (long)row * afterData.Stride), afterRow, 0, afterData.Stride);

                bool rowInBand = (row < bandY) || (row >= height - bandY);

                for (int column = 0; column < width; column++) {
                    int baseIndex = (column + offsetX) * 4;
                    int afterIndex = column * 4;

                    int deltaB = Math.Abs(baseRow[baseIndex] - afterRow[afterIndex]);
                    int deltaG = Math.Abs(baseRow[baseIndex + 1] - afterRow[afterIndex + 1]);
                    int deltaR = Math.Abs(baseRow[baseIndex + 2] - afterRow[afterIndex + 2]);
                    bool changed = deltaB > threshold || deltaG > threshold || deltaR > threshold;

                    bool inBand = rowInBand || (column < bandX) || (column >= width - bandX);
                    if (inBand) {
                        bandTotal++;
                        if (changed) { bandChanged++; }
                    } else {
                        innerTotal++;
                        if (changed) { innerChanged++; }
                    }
                }
            }

            baseImage.UnlockBits(baseData);
            afterImage.UnlockBits(afterData);
        }

        baseImage.Dispose();
        afterImage.Dispose();

        return new long[] { bandTotal, bandChanged, innerTotal, innerChanged, (long)width, (long)height };
    }

    // A headless/locked session makes CopyFromScreen return solid black, which
    // is indistinguishable from an overlay that painted nothing. Returns
    // { total, nonBlack }.
    public static long[] NonBlack(string path, int threshold) {
        Bitmap image = new Bitmap(path);
        long total = 0;
        long nonBlack = 0;
        BitmapData data = image.LockBits(
            new Rectangle(0, 0, image.Width, image.Height),
            ImageLockMode.ReadOnly,
            PixelFormat.Format32bppArgb);
        byte[] row = new byte[data.Stride];
        for (int y = 0; y < image.Height; y++) {
            Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row, 0, data.Stride);
            for (int x = 0; x < image.Width; x++) {
                int i = x * 4;
                total++;
                if (row[i] > threshold || row[i + 1] > threshold || row[i + 2] > threshold) {
                    nonBlack++;
                }
            }
        }
        image.UnlockBits(data);
        image.Dispose();
        return new long[] { total, nonBlack };
    }
}
'@

if (-not ("LsProbe" -as [type])) {
    Add-Type -TypeDefinition $probeSource -ReferencedAssemblies "System.Drawing" | Out-Null
}

# GitHub runners sit at 100% scale, but an unaware process would still report
# virtualised coordinates on any machine that does not - and the rect handed in
# is physical.
[void][LsProbe]::SetProcessDPIAware()

if (-not (Test-Path -LiteralPath $Out)) {
    New-Item -ItemType Directory -Path $Out -Force | Out-Null
}
$outDir = (Resolve-Path -LiteralPath $Out).Path

# Set-Content -Encoding UTF8 emits a BOM under PS 5.1, and Node's JSON.parse
# rejects one.
function Write-JsonFile([string]$path, [string]$json) {
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Pct([long]$changed, [long]$total) {
    if ($total -le 0) { return 0.0 }
    return [math]::Round(100.0 * $changed / $total, 3)
}

# ---------------------------------------------------------------- baseline only
if ($BaselineOnly) {
    $screen = [LsProbe]::PrimaryScreenSize()
    $baselinePath = Join-Path $outDir "baseline.png"
    [LsProbe]::Capture(0, 0, $screen[0], $screen[1], $baselinePath)

    $ink = [LsProbe]::NonBlack($baselinePath, 8)
    $baselineInfo = [pscustomobject]@{
        mode        = $Mode
        x           = 0
        y           = 0
        width       = $screen[0]
        height      = $screen[1]
        path        = $baselinePath
        nonBlackPct = (Get-Pct $ink[1] $ink[0])
    }
    Write-JsonFile (Join-Path $outDir "baseline.json") ($baselineInfo | ConvertTo-Json -Depth 4)

    Write-Host ("[win-overlay-probe] baseline {0}x{1} nonBlack={2}% -> {3}" -f `
        $screen[0], $screen[1], $baselineInfo.nonBlackPct, $baselinePath)
    if ($baselineInfo.nonBlackPct -le 0.01) {
        Write-Host "warning: the baseline is (near) solid black - this session may have no visible desktop"
    }
    $baselineInfo | ConvertTo-Json -Depth 4
    exit 0
}

# ------------------------------------------------------------------ full probe
if ($Width -le 0 -or $Height -le 0) {
    throw "-Width and -Height are required (physical pixels) unless -BaselineOnly is given"
}

if ($ProcessId -le 0) {
    $candidate = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $candidate) {
        throw "no process named '$ProcessName' and no -ProcessId given"
    }
    $ProcessId = $candidate.Id
}

$topLevelHandles = [LsProbe]::TopLevelHandles([uint32]$ProcessId)

$topLevels = @()
foreach ($handle in $topLevelHandles) {
    $topLevels += [LsProbe]::Describe($handle, $handle)
}

# Title first (build_transparent_overlay sets it), then exact rect, then the
# largest visible window - in that order, because the title is the only one of
# the three that cannot be coincidentally matched by the main shell window.
$overlayHandle = [IntPtr]::Zero
for ($i = 0; $i -lt $topLevelHandles.Count; $i++) {
    if ($topLevels[$i].Title -eq "Calibration Overlay") {
        $overlayHandle = $topLevelHandles[$i]
        break
    }
}
if ($overlayHandle -eq [IntPtr]::Zero) {
    for ($i = 0; $i -lt $topLevelHandles.Count; $i++) {
        $candidateInfo = $topLevels[$i]
        if ($candidateInfo.Left -eq $X -and $candidateInfo.Top -eq $Y -and
            $candidateInfo.Width -eq $Width -and $candidateInfo.Height -eq $Height) {
            $overlayHandle = $topLevelHandles[$i]
            break
        }
    }
}
if ($overlayHandle -eq [IntPtr]::Zero) {
    $bestArea = -1
    for ($i = 0; $i -lt $topLevelHandles.Count; $i++) {
        $candidateInfo = $topLevels[$i]
        $area = [long]$candidateInfo.Width * [long]$candidateInfo.Height
        if ($candidateInfo.Visible -and $area -gt $bestArea) {
            $bestArea = $area
            $overlayHandle = $topLevelHandles[$i]
        }
    }
}

$overlayFound = ($overlayHandle -ne [IntPtr]::Zero)
$overlayInfo = $null
$children = @()
if ($overlayFound) {
    $overlayInfo = [LsProbe]::Describe($overlayHandle, $overlayHandle)
    foreach ($childHandle in [LsProbe]::DescendantHandles($overlayHandle)) {
        $children += [LsProbe]::Describe($childHandle, $overlayHandle)
    }
}

# Two probe points: the centre, and 3% inside the top edge, which lands in the
# band where the overlay paints its capsules.
$points = @(
    @{ name = "centre";  x = $X + [int]($Width / 2); y = $Y + [int]($Height / 2) },
    @{ name = "topBand"; x = $X + [int]($Width / 2); y = $Y + [math]::Max(1, [int]($Height * 0.03)) }
)

$hits = @()
foreach ($point in $points) {
    $hitHandle = [LsProbe]::HitTest($point.x, $point.y)
    $hitInfo = $null
    $hitHex = "0x0"
    $isOverlay = $false
    $isDescendant = $false
    $rootIsOverlay = $false
    if ($hitHandle -ne [IntPtr]::Zero) {
        $hitHex = [LsProbe]::Hex($hitHandle)
        $hitInfo = [LsProbe]::Describe($hitHandle, $hitHandle)
        if ($overlayFound) {
            $isOverlay = ($hitHandle -eq $overlayHandle)
            $isDescendant = [LsProbe]::IsChild($overlayHandle, $hitHandle)
            $rootIsOverlay = ([LsProbe]::RootOf($hitHandle) -eq $overlayHandle)
        }
    }
    $hits += [pscustomobject]@{
        name              = $point.name
        x                 = $point.x
        y                 = $point.y
        hwnd              = $hitHex
        window            = $hitInfo
        isOverlayTopLevel = $isOverlay
        isOverlayChild    = $isDescendant
        rootIsOverlay     = $rootIsOverlay
        hitsOverlay       = ($isOverlay -or $isDescendant -or $rootIsOverlay)
    }
}

# ------------------------------------------------------------------- pixel diff
$afterPath = Join-Path $outDir "after.png"
[LsProbe]::Capture($X, $Y, $Width, $Height, $afterPath)

$diff = $null
$diffError = $null
if ($Baseline -ne "" -and (Test-Path -LiteralPath $Baseline)) {
    $offsetX = $X - $BaselineX
    $offsetY = $Y - $BaselineY
    if ($offsetX -lt 0 -or $offsetY -lt 0) {
        $diffError = "overlay rect starts before the baseline origin (offset $offsetX,$offsetY)"
    } else {
        $basePath = (Resolve-Path -LiteralPath $Baseline).Path
        $result = [LsProbe]::Compare($basePath, $afterPath, $offsetX, $offsetY, $BandFraction, $PixelThreshold)
        $diff = [pscustomobject]@{
            bandTotal       = $result[0]
            bandChanged     = $result[1]
            innerTotal      = $result[2]
            innerChanged    = $result[3]
            comparedWidth   = $result[4]
            comparedHeight  = $result[5]
            bandChangedPct  = (Get-Pct $result[1] $result[0])
            innerChangedPct = (Get-Pct $result[3] $result[2])
            bandFraction    = $BandFraction
            threshold       = $PixelThreshold
        }
        if ($result[4] -le 0 -or $result[5] -le 0) {
            $diffError = "baseline does not cover the overlay rect"
        }
    }
} else {
    $diffError = "no baseline image at '$Baseline'"
}

$childrenWithLayered = @($children | Where-Object { $_.Layered }).Count
$childrenWithTransparent = @($children | Where-Object { $_.Transparent }).Count

$topLevelLayeredTransparent = $false
$topLevelVisible = $false
if ($overlayFound) {
    $topLevelLayeredTransparent = ($overlayInfo.Layered -and $overlayInfo.Transparent)
    $topLevelVisible = $overlayInfo.Visible
}

$centreHit = $null
$topBandHit = $null
foreach ($hit in $hits) {
    if ($hit.name -eq "centre") { $centreHit = $hit.hitsOverlay }
    if ($hit.name -eq "topBand") { $topBandHit = $hit.hitsOverlay }
}

$bandChangedPct = $null
$innerChangedPct = $null
if ($null -ne $diff) {
    $bandChangedPct = $diff.bandChangedPct
    $innerChangedPct = $diff.innerChangedPct
}

$verdict = [pscustomobject]@{
    overlayFound               = $overlayFound
    topLevelLayeredTransparent = $topLevelLayeredTransparent
    topLevelVisible            = $topLevelVisible
    childCount                 = $children.Count
    childrenWithLayered        = $childrenWithLayered
    childrenWithTransparent    = $childrenWithTransparent
    pointHitsOverlay           = [pscustomobject]@{ centre = $centreHit; topBand = $topBandHit }
    bandChangedPct             = $bandChangedPct
    innerChangedPct            = $innerChangedPct
}

$report = [pscustomobject]@{
    mode        = $Mode
    processId   = $ProcessId
    overlayRect = [pscustomobject]@{ x = $X; y = $Y; width = $Width; height = $Height }
    baseline    = [pscustomobject]@{ path = $Baseline; x = $BaselineX; y = $BaselineY }
    afterImage  = $afterPath
    topLevels   = $topLevels
    overlay     = $overlayInfo
    children    = $children
    hitTests    = $hits
    diff        = $diff
    diffError   = $diffError
    verdict     = $verdict
}

$json = $report | ConvertTo-Json -Depth 8
Write-JsonFile (Join-Path $outDir "probe.json") $json

Write-Host ""
Write-Host "=== win-overlay-probe (mode=$Mode) ==="
Write-Host ("pid={0} overlayRect={1},{2} {3}x{4}" -f $ProcessId, $X, $Y, $Width, $Height)
if ($overlayFound) {
    Write-Host ("overlay hwnd={0} class='{1}' title='{2}' visible={3} ex={4} layered={5} transparent={6} noactivate={7}" -f `
        $overlayInfo.Hwnd, $overlayInfo.ClassName, $overlayInfo.Title, $overlayInfo.Visible, `
        $overlayInfo.ExStyle, $overlayInfo.Layered, $overlayInfo.Transparent, $overlayInfo.NoActivate)
    Write-Host ("overlay layeredAttrs={0} alpha={1} flags={2}" -f `
        $overlayInfo.HasLayeredAttrs, $overlayInfo.LayeredAlpha, $overlayInfo.LayeredFlags)
} else {
    Write-Host "overlay top-level NOT FOUND among this process's windows"
}
Write-Host ("children={0} layered={1} transparent={2}" -f $children.Count, $childrenWithLayered, $childrenWithTransparent)
foreach ($child in $children) {
    Write-Host ("  child depth={0} hwnd={1} class='{2}' pid={3} visible={4} ex={5} layered={6} transparent={7} rect={8},{9} {10}x{11}" -f `
        $child.Depth, $child.Hwnd, $child.ClassName, $child.Pid, $child.Visible, `
        $child.ExStyle, $child.Layered, $child.Transparent, $child.Left, $child.Top, $child.Width, $child.Height)
}
foreach ($hit in $hits) {
    $hitClass = "<none>"
    $hitPid = 0
    if ($null -ne $hit.window) {
        $hitClass = $hit.window.ClassName
        $hitPid = $hit.window.Pid
    }
    Write-Host ("hit {0} at {1},{2} -> hwnd={3} class='{4}' pid={5} hitsOverlay={6}" -f `
        $hit.name, $hit.x, $hit.y, $hit.hwnd, $hitClass, $hitPid, $hit.hitsOverlay)
}
if ($null -ne $diff) {
    Write-Host ("pixels band={0}% ({1}/{2}) inner={3}% ({4}/{5})" -f `
        $diff.bandChangedPct, $diff.bandChanged, $diff.bandTotal, `
        $diff.innerChangedPct, $diff.innerChanged, $diff.innerTotal)
}
if ($null -ne $diffError) {
    Write-Host "diff note: $diffError"
}
# hitsOverlay=false is the HEALTHY reading: a click-through overlay is meant to
# be skipped by hit-testing, so the point lands on whatever is underneath.
Write-Host "note: hitsOverlay=false means click-through is working"
Write-Host "=== end win-overlay-probe ==="
Write-Host ""

$json
exit 0
