# known bugs

## High priority
- create and update operations check symbolic-link paths before permission, but do not check them again immediately before applying the approved change. delete, rename, and move operations already perform the second check.

## Normal priority
- malformed bad backend responses are accepted this can cause blank answers or runtime errors instead of reporting an invalid backend response.
- intellegience selector appears on models that sometimes dont support it
- intellegience selector doesnt work on models that support it
- question and path sizes are unbounded in chatbox
- agent tool loop may trigger in some cases(model specific sometimes)
- some models return final answers instnatly instead of triggering tool loop (was with deepseek v4 pro did a temporary fix speicifcally for that model)
- viewport can get too cramped on smaller screens. tested on my laptop and the chat was too cramped.
