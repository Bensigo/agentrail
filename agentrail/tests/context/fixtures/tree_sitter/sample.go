package main

func greet(name string) string {
    return "Hello, " + name
}

func add(a, b int) int {
    return a + b
}

type Animal struct {
    Name string
    Age  int
}

type Stringer interface {
    String() string
}
