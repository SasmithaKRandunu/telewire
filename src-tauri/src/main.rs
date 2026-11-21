// Prevents a console window from appearing alongside the app on Windows
// release builds. Debug builds keep it so `tracing` output stays visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::capture();
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let msg = format!(
            "=== TELEWIRE CRASH REPORT ===\nTimestamp: {:?}\nLocation: {}\nPayload: {}\n\nBacktrace:\n{}\n=============================\n",
            std::time::SystemTime::now(),
            location,
            payload,
            backtrace
        );

        eprintln!("{msg}");

        let _ = std::fs::write("D:\\Files\\Documents\\TG Downloader\\crash.txt", &msg);
        if let Some(appdata) = dirs::data_dir() {
            let dir = appdata.join("TeleWire");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("crash.txt"), &msg);
        }
    }));

    telewire_lib::run();
}
