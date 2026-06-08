import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe629] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 rounded",
  {
    variants: {
      variant: {
        default: "bg-[#ffe629] text-black hover:bg-[#ffdc00]",
        secondary:
          "bg-[var(--gray-03)] border border-[var(--gray-06)] text-[var(--gray-12)] hover:bg-[var(--gray-04)]",
        ghost:
          "bg-transparent text-[var(--gray-11)] hover:bg-[var(--gray-02)]",
        destructive:
          "bg-[#e5484d] text-white hover:bg-[#ce2c31]",
        outline:
          "border border-[var(--gray-05)] bg-transparent text-[var(--gray-12)] hover:bg-[var(--gray-02)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
