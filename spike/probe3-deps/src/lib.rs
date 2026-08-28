pub fn touch() -> usize { core::mem::size_of::<reqwest::Client>() + core::mem::size_of::<flate2::Compression>() }
