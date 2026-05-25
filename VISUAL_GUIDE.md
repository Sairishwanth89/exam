# Face Verification Flow - Visual Guide

## 🔄 Complete User Journey

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          STUDENT STARTS EXAM                            │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│          📷 SYSTEM CHECK MODAL (Existing)                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  "🎥 System Check"                                              │   │
│  │  Video preview shows webcam feed                                │   │
│  │  Status: ✅ Camera ready!                                       │   │
│  │  [Start Exam]  ← Button click                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ Click "Start Exam"
                                  │
┌─────────────────────────────────────────────────────────────────────────┐
│          🔐 FACE VERIFICATION MODAL (NEW)                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  "🔐 Face Verification"                                         │   │
│  │  "We need to verify your identity before the exam starts"       │   │
│  │                                                                  │   │
│  │  📸 [  Camera Preview ]                                         │   │
│  │                                                                  │   │
│  │  Capturing face images...                                       │   │
│  │  ⚫ - ⚫ - ⚫     (Progress: 0/3)                               │   │
│  │  □  □  □                                                        │   │
│  │  "Waiting for clear face..."                                    │   │
│  │                                                                  │   │
│  │  [Skip]  [Start Capture]  ← Buttons                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                        ┌─────────┴─────────┐
                        │                   │
           Click        │                   │ Click
         "Start"        │                   │ "Skip"
           │            │                   │
           ▼            │                   ▼
    ┌──────────┐        │            ┌──────────┐
    │ CAPTURE  │        │            │  SKIP    │
    │ LOOP     │        │            │ VERIFY   │
    │ ACTIVE   │        │            │          │
    └──────────┘        │            └──────────┘
           │            │                   │
   Frame captured       │                   │
   every 500ms          │                   │
           │            │                   │
           ├─ Dot 1    │                   │
           │ captured  │                   │
           │ 🔵        │                   │
           │           │                   │
           ├─ Dot 2    │                   │
           │ captured  │                   │
           │ 🔵        │                   │
           │           │                   │
           ├─ Dot 3    │                   │
           │ captured  │                   │
           │ ✅        │                   │
           │           │                   │
           └─→ Finalize Enrollment◄────────┘
                        │
                        ▼
        ┌───────────────────────────┐
        │  Average 3 encodings      │
        │  Store reference          │
        │  Enable verification      │
        └───────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────┐
        │  ✅ Face verified!        │
        │  "Exam will start now..."  │
        │  (2 second delay)          │
        └───────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              📝 EXAM QUESTIONS (Existing)                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Timer starts: 10:00                                            │   │
│  │  [Question 1]  [Question 2]  [Question 3] ...                   │   │
│  │                                                                  │   │
│  │  Right sidebar: 🎥 Proctoring Monitor (webcam)                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ (Every 2.5 seconds)
                                  ▼
        ┌───────────────────────────────────┐
        │  FRAME PROCTORING LOOP            │
        │  Capture frame → Send to AI       │
        │                                   │
        │  1. Face Detection               │
        │  2. Eye Tracking                 │
        │  3. Head Pose Estimation         │
        │  4. ✨ FACE VERIFICATION ✨       │
        │     └─ Compare to reference      │
        │     └─ If match: OK              │
        │     └─ If mismatch: Counter++    │
        │                                   │
        │  If Counter >= 8:                │
        │  → FLAG: "Different person       │
        │     detected"                    │
        │                                   │
        └───────────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    OK (0)          WARNING (1)      DANGER (2+)
         │              │              │
         ▼              ▼              ▼
      Continue    Issue Warning   Terminate Exam
      Exam        Message
                  (show once,
                   continue
                   if corrected)
```

## 🔐 Face Verification Logic (During Exam)

```
Every Frame:
│
├─ Extract face encoding from current frame
│  (128-dimensional vector)
│
├─ Calculate DISTANCE to reference encoding
│  (0 = identical, 1 = completely different)
│
├─ Check: distance < 0.55 ?
│  │
│  ├─ YES (Same person)
│  │  │
│  │  └─ Reset mismatch counter to 0 ✅
│  │
│  └─ NO (Different person)
│     │
│     ├─ Increment mismatch counter++
│     │
│     ├─ Check: counter >= 8 ?
│     │  │
│     │  ├─ YES
│     │  │  └─ FLAG VIOLATION: "face_mismatch" 🚩
│     │  │     → Backend notified
│     │  │     → Can trigger warning/termination
│     │  │
│     │  └─ NO
│     │     └─ Keep watching (accumulated time)
```

## 📊 Face Distance Examples

```
Frame 1:  ┌─ Encoding
          │  (128 values)
          └─ Distance to Reference: 0.23  ← MATCH ✅
             (< 0.55 threshold)

Frame 2:  ┌─ Encoding
          │  (128 values)
          └─ Distance to Reference: 0.74  ← MISMATCH ❌
             (> 0.55 threshold)
             Counter: 1/8

Frame 3:  ┌─ Encoding
          │  (128 values)
          └─ Distance to Reference: 0.76  ← MISMATCH ❌
             Counter: 2/8

Frame 4:  ┌─ Encoding
          │  (128 values)
          └─ Distance to Reference: 0.25  ← MATCH ✅
             Counter RESET to 0/8

...

Frame 20: ┌─ Encoding
          │  (128 values)
          └─ Distance to Reference: 0.81  ← MISMATCH ❌
             Counter: 8/8
             
             ⚠️ VIOLATION FLAGGED ⚠️
             "Different person detected"
             → Action: Warning or Terminate
```

## 🎨 UI State Transitions

### Face Capture Progress Indicator

```
Initial State (before capture):
┌─────────────┐
│ ⚫ ⚫ ⚫      │  (Gray - not captured)
│ □ □ □      │
└─────────────┘

During Capture (frame 1 being captured):
┌─────────────┐
│ 🔵 ⚫ ⚫     │  (Blue - currently capturing)
│ □ □ □      │
└─────────────┘
  (Animated pulse)

After Frame 1:
┌─────────────┐
│ ✅ ⚫ ⚫     │  (Green - captured)
│ □ □ □      │
└─────────────┘

During Capture (frame 2):
┌─────────────┐
│ ✅ 🔵 ⚫     │
│ □ □ □      │
└─────────────┘

After Frame 2:
┌─────────────┐
│ ✅ ✅ ⚫     │
│ □ □ □      │
└─────────────┘

During Capture (frame 3):
┌─────────────┐
│ ✅ ✅ 🔵     │
│ □ □ □      │
└─────────────┘

Complete (3/3):
┌─────────────┐
│ ✅ ✅ ✅     │  (All green)
│ ✅ ✅ ✅     │  (All captured)
└─────────────┘
 ↓
Finalizing...
↓
✅ Face verified!
```

### Camera Border States

```
Normal (waiting):
┌──────────────────┐
│  📸 Video       │
│                │
└──────────────────┘
  (Gray border)

Capturing:
┌──────────────────┐
│  📸 Video       │
│  (glowing)      │
└──────────────────┘
  (Blue border, animated glow)

Success:
┌──────────────────┐
│  📸 Video       │
│  (verified)     │
└──────────────────┘
  (Green border, steady)

Error:
┌──────────────────┐
│  📸 Video       │
│  (not clear)    │
└──────────────────┘
  (Red border, brief)
```

## 📈 Enrollment Timeline

```
Time:    0s              1s              2s              3s
Frame:   1               2               3              Complete
         │               │               │               │
Action:  Capture    Capture        Capture         Process
         ↓              ↓               ↓               ↓

Status:  📸          📸               📸              ✅
         Encoding    Encoding         Encoding        Finalize
         stored      stored           stored          

         Buffer:     Buffer:          Buffer:         Averaging:
         [E1]        [E1, E2]         [E1, E2, E3]   E_avg = (E1+E2+E3)/3
         
Progress: 1/3         2/3              3/3            Ready
Dots:    🟦🟩🟩       🟩🟦🟩           🟩🟩🟦          🟩🟩🟩
```

## 🔄 Data Flow

```
┌──────────────┐
│   Browser    │
│              │
│  Webcam API  │
│     │        │
│     ▼        │
│   Canvas     │
│     │        │
│     ▼        │
│  Base64      │ ─────┐
│   Frame      │      │
└──────────────┘      │
                      │
                      ▼ POST /api/enroll/capture
            ┌──────────────────┐
            │  Node Backend    │
            │  ─────────────── │
            │  Validates JWT   │
            │  Routes request  │
            └──────────────────┘
                      │
                      ▼ POST /enroll/capture/<student_id>
            ┌──────────────────┐
            │  Python AI Svc   │
            │  ─────────────── │
            │  Decode Base64   │
            │       │          │
            │       ▼          │
            │  Face Detection  │
            │  (HOG Model)     │
            │       │          │
            │       ▼          │
            │ Extract Encoding │
            │  (ResNet-34)     │
            │       │          │
            │       ▼          │
            │  Store in Buffer │
            │       │          │
            │       ▼          │
            │  Return Status   │
            └──────────────────┘
                      │
                      ▼ Response (captured: true/false)
            ┌──────────────────┐
            │  Node Backend    │
            │  Pass Response   │
            └──────────────────┘
                      │
                      ▼ JSON Response
            ┌──────────────────┐
            │  Browser/JS      │
            │  Update UI       │
            │  (Progress dots) │
            └──────────────────┘
```

## 🎯 Verification Algorithm

```
During Exam (every 2.5 seconds):

1. Capture Frame
   ↓
2. Extract Encoding (128-D vector)
   ↓
3. Calculate Distance
   distance = euclidean_distance(current_encoding, reference_encoding)
   ↓
4. Compare to Threshold
   threshold = 0.55
   ↓
5. Decision Tree:
   
   if distance < threshold:
       → Same Person ✅
       → Reset counter = 0
       → Continue exam
   else:
       → Different Person ⚠️
       → counter++
       ↓
       if counter >= 8:
           → Violation Confirmed 🚩
           → Flag: "face_mismatch"
           → Action: Warning or Terminate
       else:
           → Keep Watching
           → Wait for more frames
```

## 🏆 Success Metrics

### Enrollment Success
```
Goal: Capture 3 clear faces
├─ Frame 1: ✅ Captured
├─ Frame 2: ✅ Captured  
├─ Frame 3: ✅ Captured
│
└─ Result: ✅ READY FOR EXAM
```

### Exam Verification
```
Goal: No face mismatches
├─ Same person through entire exam
├─ 0 consecutive mismatches
├─ 0 face_mismatch violations
│
└─ Result: ✅ EXAM COMPLETED SUCCESSFULLY
```

## 🚨 Violation Scenarios

### Scenario 1: Valid Student (No Flag)
```
Enrollment: Student A
Exam:       Student A entire time
Result:     ✅ No violation
```

### Scenario 2: Different Person (Flag)
```
Enrollment: Student A (frames 1-10 match)
Person Change at 5min
Exam:       Student B writes (frames 11-30 don't match)
Result:     
├─ Frame 11-18: Counter increments (1,2,3...8)
└─ Frame 18:    🚩 VIOLATION FLAGGED
                "Different person detected"
```

### Scenario 3: Minor Change (OK)
```
Enrollment: Student A (no glasses)
Exam:       Student A (with glasses, minor face change)
Result:     
├─ Distance: 0.48 (< 0.55 threshold)
└─ ✅ MATCH - No violation
```

---

## 📚 Reading This Guide

1. **Start with:** "Complete User Journey" (top section)
2. **Understand:** "Face Verification Logic" (verification algorithm)
3. **Reference:** "Data Flow" (how data moves through system)
4. **Troubleshoot:** "Violation Scenarios" (what gets flagged)

---

**Visual Guide Version:** 1.0  
**Date:** May 8, 2026
