# H2: a static page for the lifecycle tests to load. "Zero failures" must not depend on a third
# party, and the host's own address is blocked from sessions, so the page lives in S3.
# This is the one public bucket in the account, and it holds only this page.
resource "aws_s3_bucket" "testpage" {
  bucket        = "kestrel-testpage-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "testpage" {
  bucket                  = aws_s3_bucket.testpage.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "testpage" {
  statement {
    sid       = "PublicReadOfTheTestPageOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.testpage.arn}/test/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "testpage" {
  bucket     = aws_s3_bucket.testpage.id
  policy     = data.aws_iam_policy_document.testpage.json
  depends_on = [aws_s3_bucket_public_access_block.testpage]
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.testpage.id
  key          = "test/index.html"
  content_type = "text/html; charset=utf-8"
  content      = <<-HTML
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>Kestrel test page</title></head>
    <body>
    <h1 id="kestrel-ok">kestrel test page ok</h1>
    <p>This page is static. The harness loads it and checks the title and the element above.</p>
    </body>
    </html>
  HTML
}
