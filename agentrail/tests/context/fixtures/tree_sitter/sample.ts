function greet(name: string): string {
    return `Hello, ${name}`;
}

interface Shape {
    area(): number;
}

class Circle implements Shape {
    constructor(public radius: number) {}
    area(): number {
        return Math.PI * this.radius ** 2;
    }
}

type Color = "red" | "green" | "blue";
