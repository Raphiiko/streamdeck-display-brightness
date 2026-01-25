# DDC Brightness Control Plugin for Stream Deck+

A Stream Deck+ plugin that controls monitor brightness via DDC/CI protocol using dial interface.

## Features

- Dial-based brightness control
- Multi-monitor support (control multiple monitors simultaneously)
- Real-time brightness feedback on dial display
- Cross-dial synchronization (when multiple dials control same monitor)
- Average brightness display when multiple monitors are selected
- Configurable step size for dial rotation

## Requirements

- Stream Deck+ device
- Stream Deck software version 6.9 or higher
- Windows 10 or later
- DDC/CI compatible monitors
- Node.js 20+

## Installation

1. Double-click `com.raphiiko.sdbrightness.sdPlugin` to install plugin
2. Restart Stream Deck software
3. Drag "Brightness Control" action to a dial slot

## Configuration

1. Click the dial to open the Property Inspector
2. Select one or more monitors from the list
3. Adjust the step size slider (1-20) to control brightness change per tick
4. Click "Refresh Monitor List" if monitors are not detected

## Usage

- **Rotate dial**: Adjust brightness for selected monitors
- **Press dial**: Refresh monitor list
- **Short tap**: (Currently unassigned)
- **Long tap**: Set brightness to 50%

## Troubleshooting

### Monitors not detected

1. Ensure your monitor supports DDC/CI
2. Try a different cable (DisplayPort or HDMI)
3. USB-C connections may not support DDC/CI
4. Click "Refresh Monitor List" in the Property Inspector
5. Check that Windows Display settings recognizes the monitor

### Plugin not loading

1. Ensure Stream Deck software is version 6.9 or higher
2. Check logs in `com.raphiiko.sdbrightness.sdPlugin/logs/`
3. Verify Node.js 20+ is installed
4. Reinstall the plugin

### Build issues

**Note**: This plugin uses `@ddc-node/ddc-node` (Rust-based), which has prebuilt binaries for Windows. No Python or build tools are required!

```bash
cd sdbrightness
npm install
npm run build
```

## Known Limitations

- Windows only
- Not all monitors support DDC/CI
- Built-in laptop displays typically don't support DDC/CI
- Some USB-C connections don't pass DDC signals
- DDC/CI commands can be slow (~50ms per command)

## Development

```bash
# Install dependencies
cd sdbrightness
npm install

# Build
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch
```

## Technical Details

- **Native Module**: `@ddc-node/ddc-node` (Rust-based with prebuilt binaries)
- **Protocol**: DDC/CI (Display Data Channel Command Interface)
- **VCP Code**: Luminance (0x10)
- **Architecture**: Observer pattern for cross-dial synchronization

## License

MIT

## Credits

- Built with [Elgato Stream Deck SDK](https://github.com/elgatosf/streamdeck-js)
- DDC/CI support via [@ddc-node/ddc-node](https://github.com/ThalusA/ddc-node)
