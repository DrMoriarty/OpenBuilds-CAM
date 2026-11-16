; Operation 0: Laser: Vector (no path offset)
; Laser Spot Diameter: 0.1

G0 Z7; move to z-safe height
G0 F1000 X0.0000 Y0.0000

G0 Z0
G1 F700 Z-0.1000; Direct Plunge
 G1 F3000 X100.0000 Y0.0000 Z-0.1000 S1000
G1 F3000 X100.0000 Y50.0000 Z-0.1000 S1000
G1 F3000 X0.0000 Y50.0000 Z-0.1000 S1000
G1 F3000 X0.0000 Y0.0000 Z-0.1000 S1000
; retracting back to z-safe
G0 Z7
