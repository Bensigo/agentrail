fn greet(name: &str) -> String {
    format!("Hello, {}", name)
}

struct Point {
    x: f64,
    y: f64,
}

enum Direction {
    North,
    South,
    East,
    West,
}

type Meters = f64;
