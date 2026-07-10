#!/bin/bash

greet() {
    echo "Hello, $1"
}

function add() {
    echo $(($1 + $2))
}

main() {
    greet "World"
    add 1 2
}
