# Bootstrap stack (v1 plan I5): the things the main stack must not own, so that destroying and
# recreating the host keeps the same state bucket and the same public address (and so the same
# `<ip>.sslip.io` hostname).
#
# Its own state is local (gitignored). Back it up by migrating it into the bucket it creates:
#   terraform init -migrate-state -backend-config=backend.hcl   (see ../README.md)

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "kestrel"
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1" # where the public benchmark runners are (I4)
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket = "kestrel-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket
  # Terraform state is the one thing here that cannot be recreated.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# The public address. Kept outside the main stack so the hostname survives a rebuild (I5, I14).
resource "aws_eip" "host" {
  domain = "vpc"
  tags = {
    Name = "kestrel"
  }
  lifecycle {
    prevent_destroy = true
  }
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "eip_allocation_id" {
  value = aws_eip.host.id
}

output "public_ip" {
  value = aws_eip.host.public_ip
}

output "hostname" {
  description = "The hostname clients use: the address with dashes, under sslip.io (I14)."
  value       = "${replace(aws_eip.host.public_ip, ".", "-")}.sslip.io"
}
