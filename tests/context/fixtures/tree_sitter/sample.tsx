function App(): JSX.Element | null {
    return null;
}

interface ButtonProps {
    label: string;
}

class Button {
    render(): string {
        return "button";
    }
}

type Theme = "light" | "dark";
