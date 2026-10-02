# I17: stop the host every night at 02:00 India time, so a forgotten host costs about $10 a month
# rather than $140. `bin/host autostop off` flips the state for a long run.
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "kestrel-scheduler-stop"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_stop" {
  statement {
    actions   = ["ec2:StopInstances"]
    resources = [aws_instance.host.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_stop" {
  name   = "stop-the-kestrel-host"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_stop.json
}

resource "aws_scheduler_schedule" "nightly_stop" {
  name                         = "kestrel-nightly-stop"
  schedule_expression          = "cron(0 2 * * ? *)"
  schedule_expression_timezone = "Asia/Kolkata"
  state                        = var.autostop_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = [aws_instance.host.id] })
  }

  lifecycle {
    # `bin/host autostop` changes the state outside Terraform.
    ignore_changes = [state]
  }
}
