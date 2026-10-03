# A benchmark runner (HLD 13.3): a separate, small, fixed-performance machine in the host's
# region that runs the public harnesses against Kestrel's public endpoint (and against hosted
# vendors), as a customer in us-east-1 would. Off by default; create it for a run and destroy it
# after:  bin/tf main apply -var enable_runner=true  ...  bin/tf main apply
#
# It has no inbound rules at all, and the host's role (Systems Manager only), so `bin/host`
# reaches it the same way: KESTREL_TARGET=runner bin/host run -- ...

resource "aws_security_group" "runner" {
  count       = var.enable_runner ? 1 : 0
  name        = "kestrel-runner"
  description = "Kestrel benchmark runner: outbound only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "kestrel-runner" }
}

resource "aws_vpc_security_group_egress_rule" "runner_all" {
  count             = var.enable_runner ? 1 : 0
  security_group_id = aws_security_group.runner[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_instance" "runner" {
  count                       = var.enable_runner ? 1 : 0
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.runner_instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.runner[0].id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  # Node 22 and git for the harnesses; nothing else. Playwright only connects over CDP here.
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y nodejs22 nodejs22-npm git tar
    alternatives --install /usr/bin/node node /usr/bin/node-22 100 || true
    alternatives --install /usr/bin/npm npm /usr/bin/npm-22 100 || true
    alternatives --install /usr/bin/npx npx /usr/bin/npx-22 100 || true
    mkdir -p /srv/kestrel /var/log/kestrel-run /run/kestrel
    chown ec2-user:ec2-user /srv/kestrel /var/log/kestrel-run
    # An idle runner stops itself after 4 hours, in case a session forgets it (cost).
    echo "shutdown -h +240" | at now 2>/dev/null || shutdown -h +240
  EOT

  tags = { Name = "kestrel-runner" }
}
