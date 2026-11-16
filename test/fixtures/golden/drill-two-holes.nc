; Operation 0: Drill: Continuous (Centered)
; Endmill Diameter: 3
M3 S1000; Start Spindle
G4 P8; Wait 8 seconds for spindle to spin up to speed

G0 Z7; move to z-safe height
G0 F1000 X20.0000 Y20.0000

G0 Z0
G1 F700 Z0.0000; Direct Plunge
 G1 F1000 X20.0000 Y20.0000 Z-3.0000 S1000
G1 F1000 X20.0000 Y20.0000 Z0.0000 S1000

G0 Z7; move to z-safe height
G0 X60.0000 Y30.0000

G0 Z0
G1 F700 Z0.0000; Direct Plunge
 G1 F1000 X60.0000 Y30.0000 Z-3.0000 S1000
G1 F1000 X60.0000 Y30.0000 Z0.0000 S1000
; retracting back to z-safe
G0 Z7
