# typeforge — JSON to TypeScript, Go & Python Types

Transform raw JSON API payloads into clean, idiomatic type definitions across TypeScript, Go, and Python.

## Features

- **Multi-Language Output**:
  - **TypeScript**: Typed interfaces, type aliases, and optional property detection.
  - **Go**: Structs with `json:` tags, nested structs, and pointer types for nullability.
  - **Python**: `dataclass`, `TypedDict`, or Pydantic `BaseModel` schema definitions.
- **Smart Inference**: Analyzes arrays with mixed types, null values, and nested objects to produce precise union and optional types.
- **Retro CLI Interface**: Distinct retro terminal CRT interface with copy-to-clipboard functionality.
- **100% Client-Side**: Safe for API keys and proprietary schemas—zero network uploads.

## Getting Started

Open `index.html` in any modern web browser and paste your JSON payload or use it on https://jameop1.github.io/json-to-types-typeforge/
