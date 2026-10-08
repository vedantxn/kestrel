# A fresh machine for the install test (v1.0.0 acceptance): plain Ubuntu 24.04 with nested
# virtualisation and nothing of Kestrel's on it, installed only by following the README. Off by
# default; create it for a test and destroy it after:
#   bin/tf main apply -var enable_fresh_vm=true  ...  bin/tf main apply
# `KESTREL_TARGET=fresh bin/host ...` reaches it. Its first boot only adds the ec2-user account that
# bin/host's key push is limited to, and a stop after six hours in case it is forgotten.

data "aws_ssm_parameter" "ubuntu" {
  count = var.enable_fresh_vm ? 1 : 0
  name  = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_security_group" "fresh" {
  count       = var.enable_fresh_vm ? 1 : 0
  name        = "kestrel-fresh"
  description = "Kestrel install test: HTTP, HTTPS and the gateway in; everything out."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "kestrel-fresh" }
}

resource "aws_vpc_security_group_ingress_rule" "fresh" {
  for_each          = var.enable_fresh_vm ? toset(["80", "443", "8443", "8444"]) : toset([])
  security_group_id = aws_security_group.fresh[0].id
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "fresh_all" {
  count             = var.enable_fresh_vm ? 1 : 0
  security_group_id = aws_security_group.fresh[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_instance" "fresh" {
  count                       = var.enable_fresh_vm ? 1 : 0
  ami                         = data.aws_ssm_parameter.ubuntu[0].value
  instance_type               = var.fresh_instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.fresh[0].id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true

  cpu_options {
    nested_virtualization = "enabled"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 100
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOT
    #!/bin/bash
    set -eux
    id ec2-user >/dev/null 2>&1 || useradd -m -s /bin/bash ec2-user
    echo 'ec2-user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ec2-user
    chmod 0440 /etc/sudoers.d/90-ec2-user
    shutdown -h +360
  EOT

  tags = { Name = "kestrel-fresh" }
}
