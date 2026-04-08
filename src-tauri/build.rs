fn main() {
    tauri_build::build();

    // On macOS, add Swift stdlib rpath so screencapturekit can find
    // libswift_Concurrency.dylib at runtime.
    //
    // Prefer the OS-embedded path (/usr/lib/swift) which is already in the
    // dyld cache on macOS 12+. Using the Xcode toolchain copy causes duplicate
    // class registration warnings because the OS also loads the cache version.
    #[cfg(target_os = "macos")]
    {
        // /usr/lib/swift is the canonical OS location on macOS 12+ and the file
        // exists there as a regular dylib (not only in the dyld cache).
        let system_swift = "/usr/lib/swift";
        if std::path::Path::new(system_swift)
            .join("libswift_Concurrency.dylib")
            .exists()
        {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", system_swift);
        } else {
            // Fallback: find Xcode toolchain Swift-5.5 macosx libs via xcrun.
            if let Some(path) = xcode_swift_macosx_lib_path() {
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", path);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn xcode_swift_macosx_lib_path() -> Option<String> {
    let output = std::process::Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let swiftc = String::from_utf8(output.stdout).ok()?;
    let toolchain_usr = std::path::Path::new(swiftc.trim())
        .parent()? // bin
        .parent()?; // usr
    let candidate = toolchain_usr.join("lib/swift-5.5/macosx");
    if candidate.exists() {
        return Some(candidate.to_string_lossy().into_owned());
    }
    None
}
