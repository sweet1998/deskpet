#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

static void Fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

static NSArray<VNRecognizedTextObservation *> *SortedObservations(NSArray *values) {
    return [values sortedArrayUsingComparator:^NSComparisonResult(
        VNRecognizedTextObservation *left,
        VNRecognizedTextObservation *right
    ) {
        CGFloat vertical = left.boundingBox.origin.y - right.boundingBox.origin.y;
        if (fabs(vertical) > 0.01) return vertical > 0 ? NSOrderedAscending : NSOrderedDescending;
        return left.boundingBox.origin.x < right.boundingBox.origin.x ? NSOrderedAscending : NSOrderedDescending;
    }];
}

static NSString *RecognizeImage(CGImageRef image, CGImagePropertyOrientation orientation, NSError **error) {
    __block NSArray<VNRecognizedTextObservation *> *observations = @[];
    __block NSError *requestError = nil;
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc]
        initWithCompletionHandler:^(VNRequest *completed, NSError *failure) {
            if (failure) requestError = failure;
            else observations = (NSArray<VNRecognizedTextObservation *> *)(completed.results ?: @[]);
        }];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    request.recognitionLanguages = @[@"zh-Hans", @"en-US"];

    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc]
        initWithCGImage:image orientation:orientation options:@{}];
    NSError *performError = nil;
    if (![handler performRequests:@[request] error:&performError] || requestError) {
        if (error) *error = requestError ?: performError;
        return @"";
    }

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in SortedObservations(observations)) {
        VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
        if (candidate.string.length > 0) [lines addObject:candidate.string];
    }
    return [lines componentsJoinedByString:@"\n"];
}

static NSString *RecognizeImageFile(NSURL *url, NSError **error) {
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) return @"";
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    CGImagePropertyOrientation orientation = (CGImagePropertyOrientation)[properties[(NSString *)kCGImagePropertyOrientation] unsignedIntValue];
    if (orientation < 1 || orientation > 8) orientation = kCGImagePropertyOrientationUp;
    NSString *text = image ? RecognizeImage(image, orientation, error) : @"";
    if (image) CGImageRelease(image);
    CFRelease(source);
    return text;
}

static NSString *RecognizePdf(NSURL *url, NSInteger maxPages, NSInteger *processedPages, BOOL *truncated, NSError **error) {
    PDFDocument *document = [[PDFDocument alloc] initWithURL:url];
    if (!document) return @"";
    NSInteger pageCount = document.pageCount;
    NSInteger limit = MIN(pageCount, MAX(1, maxPages));
    NSMutableArray<NSString *> *sections = [NSMutableArray array];
    for (NSInteger index = 0; index < limit; index += 1) {
        @autoreleasepool {
            PDFPage *page = [document pageAtIndex:index];
            if (!page) continue;
            NSString *pageText = [page.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            if (pageText.length == 0) {
                NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
                CGFloat longest = MAX(bounds.size.width, bounds.size.height);
                CGFloat scale = longest > 0 ? MIN(2.0, 2200.0 / longest) : 1.0;
                NSSize size = NSMakeSize(MAX(1, bounds.size.width * scale), MAX(1, bounds.size.height * scale));
                NSImage *thumbnail = [page thumbnailOfSize:size forBox:kPDFDisplayBoxMediaBox];
                CGImageRef image = [thumbnail CGImageForProposedRect:NULL context:nil hints:nil];
                if (!image) continue;
                NSError *pageError = nil;
                pageText = RecognizeImage(image, kCGImagePropertyOrientationUp, &pageError);
                if (pageError && error) *error = pageError;
            }
            if (pageText.length > 0) {
                [sections addObject:[NSString stringWithFormat:@"[第 %ld 页]\n%@", (long)(index + 1), pageText]];
            }
        }
    }
    if (processedPages) *processedPages = limit;
    if (truncated) *truncated = pageCount > limit;
    return [sections componentsJoinedByString:@"\n\n"];
}

static void PrintResult(NSString *text, NSInteger pages, BOOL truncated) {
    NSDictionary *result = @{
        @"ok": @(text.length > 0),
        @"text": text ?: @"",
        @"pages": @(pages),
        @"truncated": @(truncated),
    };
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
    if (!data || error) Fail(@"无法生成 OCR 结果");
    fwrite(data.bytes, 1, data.length, stdout);
    fwrite("\n", 1, 1, stdout);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) Fail(@"缺少待识别文件");
        NSString *filePath = [NSString stringWithUTF8String:argv[1]];
        if (![[NSFileManager defaultManager] fileExistsAtPath:filePath]) Fail(@"待识别文件不存在");
        NSInteger maxPages = argc >= 3 ? MAX(1, atoi(argv[2])) : 20;
        NSURL *url = [NSURL fileURLWithPath:filePath];
        NSError *error = nil;
        NSInteger pages = 1;
        BOOL truncated = NO;
        NSString *text = nil;
        if ([[filePath.pathExtension lowercaseString] isEqualToString:@"pdf"]) {
            text = RecognizePdf(url, maxPages, &pages, &truncated, &error);
        } else {
            text = RecognizeImageFile(url, &error);
        }
        if (error && text.length == 0) Fail([NSString stringWithFormat:@"OCR 识别失败：%@", error.localizedDescription]);
        PrintResult(text ?: @"", pages, truncated);
    }
}
