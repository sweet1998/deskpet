#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

static void Fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

static NSString *AuthorizationName(SFSpeechRecognizerAuthorizationStatus status) {
    switch (status) {
        case SFSpeechRecognizerAuthorizationStatusAuthorized: return @"authorized";
        case SFSpeechRecognizerAuthorizationStatusDenied: return @"denied";
        case SFSpeechRecognizerAuthorizationStatusRestricted: return @"restricted";
        case SFSpeechRecognizerAuthorizationStatusNotDetermined: return @"not-determined";
    }
    return @"unknown";
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) Fail(@"缺少待识别的音频文件");
        NSString *firstArgument = [NSString stringWithUTF8String:argv[1]];
        if ([firstArgument isEqualToString:@"--status"]) {
            printf("%s\n", AuthorizationName([SFSpeechRecognizer authorizationStatus]).UTF8String);
            return 0;
        }
        NSString *audioPath = firstArgument;
        NSString *localeName = argc >= 3 ? [NSString stringWithUTF8String:argv[2]] : @"zh-CN";
        if (![[NSFileManager defaultManager] fileExistsAtPath:audioPath]) Fail(@"音频文件不存在");

        __block NSInteger authorization = -1;
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            authorization = status;
        }];
        NSDate *authorizationDeadline = [NSDate dateWithTimeIntervalSinceNow:30];
        while (authorization < 0 && authorizationDeadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (authorization != SFSpeechRecognizerAuthorizationStatusAuthorized) {
            if (authorization == SFSpeechRecognizerAuthorizationStatusDenied) {
                Fail(@"语音识别权限已被拒绝，请在系统设置中允许麦麦使用语音识别");
            }
            if (authorization == SFSpeechRecognizerAuthorizationStatusRestricted) {
                Fail(@"当前系统限制了语音识别");
            }
            Fail(@"未取得语音识别权限");
        }

        SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc]
            initWithLocale:[NSLocale localeWithLocaleIdentifier:localeName]];
        if (!recognizer || !recognizer.available) Fail(@"macOS 中文语音识别当前不可用");

        NSURL *audioURL = [NSURL fileURLWithPath:audioPath];
        SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:audioURL];
        request.shouldReportPartialResults = NO;
        if (@available(macOS 13.0, *)) request.addsPunctuation = YES;

        __block NSString *transcript = @"";
        __block NSError *recognitionError = nil;
        __block BOOL finished = NO;
        SFSpeechRecognitionTask *task = [recognizer recognitionTaskWithRequest:request
            resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                if (result) {
                    transcript = result.bestTranscription.formattedString ?: @"";
                    if (result.final) finished = YES;
                }
                if (error) {
                    recognitionError = error;
                    finished = YES;
                }
            }];

        NSDate *recognitionDeadline = [NSDate dateWithTimeIntervalSinceNow:60];
        while (!finished && recognitionDeadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (!finished) [task cancel];

        NSString *normalized = [transcript stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (normalized.length > 0) {
            printf("%s\n", normalized.UTF8String);
            return 0;
        }
        if (recognitionError) {
            Fail([NSString stringWithFormat:@"语音识别失败：%@", recognitionError.localizedDescription]);
        }
        Fail(finished ? @"没有识别到清晰语音" : @"语音识别超时");
    }
}
