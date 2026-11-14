#include "bindings/bindings.h"
#import <AVFoundation/AVFoundation.h>

int main(int argc, char * argv[]) {
	// PartyMix is a music player: "playback" keeps the sound going with the screen locked, in the background
	// and with the silent switch on (with UIBackgroundModes audio in Info.plist).
	@autoreleasepool {
		AVAudioSession *session = [AVAudioSession sharedInstance];
		[session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:nil];
		[session setActive:YES error:nil];
	}
	ffi::start_app();
	return 0;
}
