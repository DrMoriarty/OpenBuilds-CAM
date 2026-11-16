; Operation 0: CNC: Vector (path inside)
; Endmill Diameter: 3
M3 S1000; Start Spindle
G4 P8; Wait 8 seconds for spindle to spin up to speed

G0 Z7; move to z-safe height
G0 F1000 X1.5000 Y1.5000

G0 Z0
G1 F700 Z-3.0000; Direct Plunge
 G1 F1000 X98.5000 Y1.5000 Z-3.0000 S1000
G1 F1000 X98.5000 Y48.5000 Z-3.0000 S1000
G1 F1000 X1.5000 Y48.5000 Z-3.0000 S1000
G1 F1000 X1.5000 Y1.5000 Z-3.0000 S1000
; retracting back to z-safe
G0 Z7
